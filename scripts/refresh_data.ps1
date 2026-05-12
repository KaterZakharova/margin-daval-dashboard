$ErrorActionPreference = "Stop"

$OutDir   = if ($env:OUT_DIR) { $env:OUT_DIR } else { $PSScriptRoot | Split-Path }
$DataPath = Join-Path $OutDir "data.json"

$SqlConn          = $env:SQL_CONN
$ODataUrl         = $env:ODATA_URL
$ODataKey         = $env:ODATA_KEY
$ODataHeaders     = @{ "X-API-Key" = $ODataKey }

$StartDate         = [datetime]"2024-01-01"
$EndDateExclusive  = (Get-Date).Date.AddDays(1)
$ContractChannel   = "S3 КОНТРАКТНОЕ ПРОИЗВОДСТВО"
$DavThreshold      = 2

function To-Num($value) {
    if ($null -eq $value -or $value -is [DBNull]) { return 0.0 }
    $s = ([string]$value).Trim().Replace(" ","").Replace([string][char]160,"").Replace(",",".")
    if ($s -eq "") { return 0.0 }
    $d = 0.0
    if ([double]::TryParse($s,[Globalization.NumberStyles]::Any,[Globalization.CultureInfo]::InvariantCulture,[ref]$d)) { return $d }
    return 0.0
}

function Normalize-Sku($sku) {
    $s = ([string]$sku).Trim().ToUpperInvariant().Replace([string][char]0xFEFF,"")
    if ($s.StartsWith("BK") -and $s.Length -gt 2) { return $s.Substring(2) }
    return $s
}

function Escape-ODataString($value) { return ([string]$value).Replace("'","''") }

function Invoke-OData($entity, $query, $timeout = 120) {
    $entityEncoded = [uri]::EscapeDataString($entity)
    $uri = "$ODataUrl/odata/${entityEncoded}?`$format=json&$query"
    return Invoke-RestMethod -Method Get -Uri $uri -Headers $ODataHeaders -TimeoutSec $timeout
}

function Invoke-SqlRows($query) {
    $conn = New-Object System.Data.SqlClient.SqlConnection $SqlConn
    try {
        $conn.Open()
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $query
        $cmd.CommandTimeout = 240
        $adapter = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
        $table = New-Object System.Data.DataTable
        [void]$adapter.Fill($table)
        $rows = New-Object System.Collections.Generic.List[object]
        foreach ($row in $table.Rows) {
            $obj = [ordered]@{}
            foreach ($col in $table.Columns) { $obj[$col.ColumnName] = $row[$col.ColumnName] }
            $rows.Add([pscustomobject]$obj)
        }
        return $rows.ToArray()
    } finally {
        if ($conn.State -eq 'Open') { $conn.Close() }
    }
}

Write-Host "Reading sales fact..."
$sql = @"
WITH bs AS (
    SELECT ibs_partner, MAX(ibs_main_manager) AS manager
    FROM fact.tb_buyers_suppliers GROUP BY ibs_partner
)
SELECT
    CONVERT(char(7), sf.cbsf_period, 120) AS MonthCode,
    YEAR(sf.cbsf_period) AS SaleYear,
    MONTH(sf.cbsf_period) AS SaleMonth,
    CAST(sf.cbsf_client AS nvarchar(400)) AS Customer,
    CAST(COALESCE(bs.manager, N'Не указан') AS nvarchar(250)) AS Manager,
    CAST(COALESCE(NULLIF(sf.cbsf_brand, ''), N'Не указан') AS nvarchar(250)) AS Brand,
    CAST(sf.cbsf_article_number AS nvarchar(100)) AS Sku,
    MAX(CAST(sf.cbsf_nomenclature AS nvarchar(500))) AS ProductName,
    SUM(CAST(sf.cbsf_quantity AS float)) AS Qty,
    SUM(CAST(sf.cbsf_revenue_without_vat AS float)) AS RevenueNoVat,
    SUM(CAST(sf.cbsf_planned_gross_margin AS float)) AS MarginRub,
    COUNT(*) AS RowsCount
FROM fact.tb_сube_sales_fact sf
LEFT JOIN bs ON bs.ibs_partner = sf.cbsf_client
  OR bs.ibs_partner = REPLACE(REPLACE(REPLACE(REPLACE(sf.cbsf_client,' (S3)',''),' (S2)',''),' (S1)',''),' (S12)','')
WHERE sf.cbsf_period >= '$($StartDate.ToString("yyyy-MM-dd"))'
  AND sf.cbsf_period < '$($EndDateExclusive.ToString("yyyy-MM-dd"))'
  AND sf.cbsf_sales_channel = N'$ContractChannel'
  AND ISNULL(sf.cbsf_article_number, N'') <> N'Артикул'
  AND ISNULL(sf.cbsf_nomenclature, N'') NOT LIKE N'%Разработка рецептуры%'
GROUP BY
    CONVERT(char(7), sf.cbsf_period, 120), YEAR(sf.cbsf_period), MONTH(sf.cbsf_period),
    sf.cbsf_client, COALESCE(bs.manager, N'Не указан'),
    COALESCE(NULLIF(sf.cbsf_brand, ''), N'Не указан'), sf.cbsf_article_number
HAVING SUM(CAST(sf.cbsf_revenue_without_vat AS float)) <> 0
"@

$sales = @(Invoke-SqlRows $sql | ForEach-Object {
    $rev = To-Num $_.RevenueNoVat
    $margin = To-Num $_.MarginRub
    [pscustomobject]@{
        month = [string]$_.MonthCode
        year = [int]$_.SaleYear
        monthNum = [int]$_.SaleMonth
        customer = [string]$_.Customer
        manager = if ([string]::IsNullOrWhiteSpace([string]$_.Manager)) { "Не указан" } else { [string]$_.Manager }
        brand = if ([string]::IsNullOrWhiteSpace([string]$_.Brand)) { "Не указан" } else { [string]$_.Brand }
        sku = [string]$_.Sku
        skuNorm = Normalize-Sku $_.Sku
        productName = [string]$_.ProductName
        qty = To-Num $_.Qty
        revenue = $rev
        marginRub = $margin
        marginPct = if ($rev -ne 0) { $margin / $rev } else { 0.0 }
        rows = [int]$_.RowsCount
    }
})

$skuSales = $sales | Group-Object skuNorm | ForEach-Object {
    $g = $_.Group
    [pscustomobject]@{
        skuNorm = $_.Name
        sku = ($g | Select-Object -First 1).sku
        productName = ($g | Select-Object -First 1).productName
    }
}

$nomenclatureBySku = @{}
$specsBySku = @{}
$materialLinesBySpec = @{}
$parentCache = @{}

function Get-NomenclatureByArticle($skuNorm) {
    if ($nomenclatureBySku.ContainsKey($skuNorm)) { return $nomenclatureBySku[$skuNorm] }
    if ([string]::IsNullOrWhiteSpace($skuNorm) -or $skuNorm -eq "-") { $nomenclatureBySku[$skuNorm] = $null; return $null }
    $safe = Escape-ODataString $skuNorm
    $filter = [uri]::EscapeDataString("Артикул eq '$safe' and DeletionMark eq false and IsFolder eq false")
    $select = [uri]::EscapeDataString("Ref_Key,Артикул,Description")
    try {
        $r = Invoke-OData "Catalog_Номенклатура" "`$select=$select&`$filter=$filter&`$top=1" 60
        $item = if (@($r.value).Count -gt 0) { @($r.value)[0] } else { $null }
        $nomenclatureBySku[$skuNorm] = $item; return $item
    } catch { $nomenclatureBySku[$skuNorm] = $null; return $null }
}

function Get-ParentName($parentKey) {
    $parentKey = ([string]$parentKey).Trim()
    if ($parentKey -eq "" -or $parentKey -eq "00000000-0000-0000-0000-000000000000") { return "" }
    if ($parentCache.ContainsKey($parentKey)) { return $parentCache[$parentKey] }
    $filter = [uri]::EscapeDataString("Ref_Key eq guid'$parentKey'")
    $select = [uri]::EscapeDataString("Ref_Key,Description")
    try {
        $r = Invoke-OData "Catalog_Номенклатура" "`$select=$select&`$filter=$filter&`$top=1" 60
        $name = if (@($r.value).Count -gt 0) { [string]@($r.value)[0].Description } else { "" }
        $parentCache[$parentKey] = $name; return $name
    } catch { $parentCache[$parentKey] = ""; return "" }
}

function Get-SpecsForProduct($skuNorm, $nomenclatureKey) {
    if ($specsBySku.ContainsKey($skuNorm)) { return $specsBySku[$skuNorm] }
    if (-not $nomenclatureKey) { $specsBySku[$skuNorm] = @(); return @() }
    $filter = [uri]::EscapeDataString("ОсновноеИзделиеНоменклатура_Key eq guid'$nomenclatureKey' and DeletionMark eq false")
    $select = [uri]::EscapeDataString("Ref_Key,Code,Description,Статус,НачалоДействия,КонецДействия")
    try {
        $r = Invoke-OData "Catalog_РесурсныеСпецификации" "`$select=$select&`$filter=$filter&`$top=200&`$orderby=НачалоДействия desc" 120
        $specsBySku[$skuNorm] = @($r.value); return $specsBySku[$skuNorm]
    } catch { $specsBySku[$skuNorm] = @(); return @() }
}

function Classify-MaterialLine($article, $parentName, $name) {
    $a = ([string]$article).ToLowerInvariant()
    $p = ([string]$parentName).ToLowerInvariant()
    $n = ([string]$name).ToLowerInvariant()
    if ($a -match "raw" -or $p -match "сырье|актив|отдуш|экстракт|масл|консервант|красител|пав|эмульгатор|компонент|ингредиент|контрактники сырье") { return "Сырье" }
    if ($p -match "этикет|стикер|тара|упаков|туб|тубус|пакет|укупор|крыш|флакон|короб|гофро|банка|дозатор" -or $a -match "^(pac|box|label|korob|st)") { return "Материал" }
    if ($n -match "этикет|стикер|туб|флакон|короб|банка|крыш|дозатор|пакет|гофро") { return "Материал" }
    return "Материал"
}

function Get-DavMaterialsForSpec($specKey) {
    if ($materialLinesBySpec.ContainsKey($specKey)) { return $materialLinesBySpec[$specKey] }
    $filter = [uri]::EscapeDataString("Ref_Key eq guid'$specKey' and substringof('stm', Номенклатура/Артикул)")
    try {
        $r = Invoke-OData "Catalog_РесурсныеСпецификации_МатериалыИУслуги" "`$expand=Номенклатура&`$filter=$filter&`$top=500&`$orderby=LineNumber" 120
        $items = @()
        foreach ($line in @($r.value)) {
            $nom = $line.Номенклатура
            $article = if ($nom) { [string]$nom.Артикул } else { "" }
            $name = if ($nom) { [string]$nom.Description } else { "" }
            $parentName = if ($nom) { Get-ParentName $nom.Parent_Key } else { "" }
            $class = Classify-MaterialLine $article $parentName $name
            $items += [pscustomobject]@{
                specKey = [string]$line.Ref_Key; lineNumber = [int]$line.LineNumber
                materialArticle = $article; materialName = $name; parentFolder = $parentName
                materialClass = $class; quantityInSpec = To-Num $line.КоличествоУпаковок
                supplyMethod = [string]$line.СпособПолученияМатериала
            }
        }
        $materialLinesBySpec[$specKey] = $items; return $items
    } catch { $materialLinesBySpec[$specKey] = @(); return @() }
}

function Get-Scheme($rawCount, $matCount) {
    if ($rawCount -gt 0 -and $matCount -ge $DavThreshold) { return "Смешанная схема" }
    if ($rawCount -gt 0 -and $matCount -lt $DavThreshold) { return "Давальческая: сырье" }
    if ($matCount -ge $DavThreshold) { return "Давальческая схема" }
    return "Под ключ"
}

Write-Host "Classifying SKU through resource specifications..."
$skuClassRows = New-Object System.Collections.Generic.List[object]
$rsRows = New-Object System.Collections.Generic.List[object]
$materialRows = New-Object System.Collections.Generic.List[object]
$i = 0
foreach ($s in $skuSales) {
    $i++
    if ($i % 25 -eq 0) { Write-Host "  SKU $i / $($skuSales.Count)" }
    $n = Get-NomenclatureByArticle $s.skuNorm
    $specs = if ($n) { @(Get-SpecsForProduct $s.skuNorm $n.Ref_Key) } else { @() }
    $summaries = @()
    foreach ($sp in $specs) {
        $materials = @(Get-DavMaterialsForSpec $sp.Ref_Key)
        $rawCount = @($materials | Where-Object { $_.materialClass -eq "Сырье" }).Count
        $matCount = @($materials | Where-Object { $_.materialClass -eq "Материал" }).Count
        $scheme = Get-Scheme $rawCount $matCount
        $summary = [pscustomobject]@{
            sku=$s.sku; skuNorm=$s.skuNorm
            productName = if ($n) { [string]$n.Description } else { $s.productName }
            specKey=[string]$sp.Ref_Key; specCode=[string]$sp.Code; specName=[string]$sp.Description
            specStatus=[string]$sp.Статус
            specStart = if ($sp.НачалоДействия) { ([datetime]$sp.НачалоДействия).ToString("yyyy-MM-dd") } else { "" }
            specEnd   = if ($sp.КонецДействия)   { ([datetime]$sp.КонецДействия).ToString("yyyy-MM-dd")   } else { "" }
            davRaw=$rawCount; davMaterials=$matCount; davTotal=$rawCount+$matCount; scheme=$scheme
            rank = if ($scheme -eq "Смешанная схема") { 4 } elseif ($scheme -eq "Давальческая: сырье") { 3 } elseif ($scheme -eq "Давальческая схема") { 2 } else { 1 }
        }
        $summaries += $summary; $rsRows.Add($summary)
        foreach ($m in $materials) {
            $materialRows.Add([pscustomobject]@{
                sku=$s.sku; productName=$summary.productName; specKey=$summary.specKey; specCode=$summary.specCode
                lineNumber=$m.lineNumber; materialArticle=$m.materialArticle; materialName=$m.materialName
                parentFolder=$m.parentFolder; materialClass=$m.materialClass
                quantityInSpec=$m.quantityInSpec; supplyMethod=$m.supplyMethod
            })
        }
    }
    $chosen = $null
    if ($summaries.Count -gt 0) {
        $chosen = $summaries |
            Sort-Object @{Expression={if($_.specStatus -eq "Действует"){1}else{0}};Descending=$true},
                        @{Expression="rank";Descending=$true},
                        @{Expression="specStart";Descending=$true} |
            Select-Object -First 1
    }
    $skuClassRows.Add([pscustomobject]@{
        sku=$s.sku; skuNorm=$s.skuNorm
        productName = if ($chosen) { $chosen.productName } else { $s.productName }
        productFound1C = if ($n) { $true } else { $false }
        specsFound=$specs.Count
        specKey    = if ($chosen) { $chosen.specKey }    else { "" }
        specCode   = if ($chosen) { $chosen.specCode }   else { "" }
        specStatus = if ($chosen) { $chosen.specStatus } else { "" }
        specStart  = if ($chosen) { $chosen.specStart }  else { "" }
        specEnd    = if ($chosen) { $chosen.specEnd }    else { "" }
        davRaw      = if ($chosen) { $chosen.davRaw }      else { 0 }
        davMaterials= if ($chosen) { $chosen.davMaterials} else { 0 }
        davTotal    = if ($chosen) { $chosen.davTotal }    else { 0 }
        hasDavRaw      = if ($chosen) { $chosen.davRaw -gt 0 } else { $false }
        hasDavMaterials= if ($chosen) { $chosen.davMaterials -gt 0 } else { $false }
        isMixed = if ($chosen) { $chosen.davRaw -gt 0 -and $chosen.davMaterials -ge $DavThreshold } else { $false }
        scheme = if ($chosen) { $chosen.scheme } elseif ($n) { "РС не найдена" } else { "Не найден артикул в 1С" }
    })
}

$classMap = @{}
foreach ($r in $skuClassRows) { $classMap[$r.skuNorm] = $r }

$salesEnriched = @($sales | ForEach-Object {
    $c = $classMap[$_.skuNorm]
    [pscustomobject]@{
        month=$_.month; year=$_.year; monthNum=$_.monthNum
        customer=$_.customer; manager=$_.manager; brand=$_.brand
        sku=$_.sku
        productName = if ($c -and $c.productName) { $c.productName } else { $_.productName }
        qty=[math]::Round($_.qty,3); revenue=[math]::Round($_.revenue,2); marginRub=[math]::Round($_.marginRub,2)
        marginPct=$_.marginPct
        scheme         = if ($c) { $c.scheme }          else { "Не классифицировано" }
        davRaw         = if ($c) { $c.davRaw }           else { 0 }
        davMaterials   = if ($c) { $c.davMaterials }     else { 0 }
        davTotal       = if ($c) { $c.davTotal }         else { 0 }
        hasDavRaw      = if ($c) { $c.hasDavRaw }        else { $false }
        hasDavMaterials= if ($c) { $c.hasDavMaterials }  else { $false }
        isMixed        = if ($c) { $c.isMixed }          else { $false }
        specKey    = if ($c) { $c.specKey }    else { "" }
        specCode   = if ($c) { $c.specCode }   else { "" }
        specStatus = if ($c) { $c.specStatus } else { "" }
    }
})

$payload = [ordered]@{
    meta = [ordered]@{
        generatedAt      = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
        source           = "fact.tb_сube_sales_fact / cbsf_planned_gross_margin"
        channel          = $ContractChannel
        startDate        = $StartDate.ToString("yyyy-MM-dd")
        endDateExclusive = $EndDateExclusive.ToString("yyyy-MM-dd")
        marginMeasure    = "Валовая маржа плановая"
        davThreshold     = $DavThreshold
        rule             = "0-1 дав. материал = Под ключ; 2+ дав. материалов = Давальческая схема; дав. сырье фильтруется отдельно; сырье+2+ материалов = Смешанная схема"
    }
    sales          = $salesEnriched
    skuClass       = $skuClassRows
    resourceSpecs  = $rsRows
    materials      = $materialRows
}

Write-Host "Writing data.json ($DataPath)..."
$json = $payload | ConvertTo-Json -Depth 12
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($DataPath, $json, $utf8)
Write-Host "Done. generatedAt=$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))"
