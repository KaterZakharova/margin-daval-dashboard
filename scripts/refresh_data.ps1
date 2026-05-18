$ErrorActionPreference = "Stop"

$OutDir   = if ($env:OUT_DIR) { $env:OUT_DIR } else { $PSScriptRoot | Split-Path }
$DataPath = Join-Path $OutDir "data.json"

$SqlConn      = $env:SQL_CONN
$ODataUrl     = $env:ODATA_URL
$ODataKey     = $env:ODATA_KEY
$ODataHeaders = @{ "X-API-Key" = $ODataKey }

$StartDate        = [datetime]"2024-01-01"
$EndDateExclusive = (Get-Date).Date.AddDays(1)
$ContractChannel  = "S3 КОНТРАКТНОЕ ПРОИЗВОДСТВО"
$DavThreshold     = 2

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

# ── SQL: продажи ────────────────────────────────────────────────────────────
Write-Host "Reading sales fact..."
$sql = @"
WITH bs AS (
    SELECT ibs_partner, MAX(ibs_main_manager) AS manager
    FROM fact.tb_buyers_suppliers GROUP BY ibs_partner
)
SELECT
    CONVERT(char(7), sf.cbsf_period, 120) AS MonthCode,
    YEAR(sf.cbsf_period)  AS SaleYear,
    MONTH(sf.cbsf_period) AS SaleMonth,
    CAST(sf.cbsf_client AS nvarchar(400)) AS Customer,
    CAST(COALESCE(bs.manager, N'Не указан') AS nvarchar(250)) AS Manager,
    CAST(COALESCE(NULLIF(sf.cbsf_brand,''), N'Не указан') AS nvarchar(250)) AS Brand,
    CAST(sf.cbsf_article_number AS nvarchar(100)) AS Sku,
    MAX(CAST(sf.cbsf_nomenclature AS nvarchar(500))) AS ProductName,
    SUM(CAST(sf.cbsf_quantity              AS float)) AS Qty,
    SUM(CAST(sf.cbsf_revenue_without_vat   AS float)) AS RevenueNoVat,
    SUM(CAST(sf.cbsf_planned_gross_margin  AS float)) AS MarginRub,
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
    sf.cbsf_client,
    COALESCE(bs.manager, N'Не указан'),
    COALESCE(NULLIF(sf.cbsf_brand,''), N'Не указан'),
    sf.cbsf_article_number
HAVING SUM(CAST(sf.cbsf_revenue_without_vat AS float)) <> 0
"@

$sales = @(Invoke-SqlRows $sql | ForEach-Object {
    $rev    = To-Num $_.RevenueNoVat
    $margin = To-Num $_.MarginRub
    [pscustomobject]@{
        month      = [string]$_.MonthCode
        year       = [int]$_.SaleYear
        monthNum   = [int]$_.SaleMonth
        customer   = [string]$_.Customer
        manager    = if ([string]::IsNullOrWhiteSpace([string]$_.Manager)) { "Не указан" } else { [string]$_.Manager }
        brand      = if ([string]::IsNullOrWhiteSpace([string]$_.Brand))   { "Не указан" } else { [string]$_.Brand }
        sku        = [string]$_.Sku
        skuNorm    = Normalize-Sku $_.Sku
        productName = [string]$_.ProductName
        qty        = To-Num $_.Qty
        revenue    = $rev
        marginRub  = $margin
        marginPct  = if ($rev -ne 0) { $margin / $rev } else { 0.0 }
        rows       = [int]$_.RowsCount
    }
})

$skuSales = @($sales | Group-Object skuNorm | ForEach-Object {
    $g = $_.Group
    [pscustomobject]@{
        skuNorm     = $_.Name
        sku         = ($g | Select-Object -First 1).sku
        productName = ($g | Select-Object -First 1).productName
    }
})

Write-Host "Classifying $($skuSales.Count) unique SKUs via OData (parallel, throttle=8)..."

# ── OData классификация — параллельно ────────────────────────────────────────
$classResults = $skuSales | ForEach-Object -Parallel {
    $s            = $_
    $ODataUrl     = $using:ODataUrl
    $ODataHeaders = $using:ODataHeaders
    $DavThreshold = $using:DavThreshold

    function p_OData($entity, $query, $timeout = 120) {
        $uri = "$ODataUrl/odata/$([uri]::EscapeDataString($entity))?`$format=json&$query"
        try { return Invoke-RestMethod -Method Get -Uri $uri -Headers $ODataHeaders -TimeoutSec $timeout }
        catch { return $null }
    }

    function p_Classify($article, $parentName, $name) {
        $a = ([string]$article).ToLowerInvariant()
        $p = ([string]$parentName).ToLowerInvariant()
        $n = ([string]$name).ToLowerInvariant()
        if ($a -match "raw" -or $p -match "сырье|актив|отдуш|экстракт|масл|консервант|красител|пав|эмульгатор|компонент|ингредиент|контрактники сырье") { return "Сырье" }
        return "Материал"
    }

    function p_Scheme($rawCount, $matCount, $thr) {
        if ($rawCount -gt 0 -and $matCount -ge $thr) { return "Смешанная схема" }
        if ($rawCount -gt 0 -and $matCount -lt $thr) { return "Давальческая: сырье" }
        if ($matCount -ge $thr) { return "Давальческая схема" }
        return "Под ключ"
    }

    $skuNorm = $s.skuNorm
    $n = $null
    if (-not [string]::IsNullOrWhiteSpace($skuNorm) -and $skuNorm -ne "-") {
        $safe   = ([string]$skuNorm).Replace("'","''")
        $filter = [uri]::EscapeDataString("Артикул eq '$safe' and DeletionMark eq false and IsFolder eq false")
        $select = [uri]::EscapeDataString("Ref_Key,Артикул,Description")
        $r = p_OData "Catalog_Номенклатура" "`$select=$select&`$filter=$filter&`$top=1" 60
        if ($r -and @($r.value).Count -gt 0) { $n = @($r.value)[0] }
    }

    $specs = @()
    if ($n) {
        $filter = [uri]::EscapeDataString("ОсновноеИзделиеНоменклатура_Key eq guid'$($n.Ref_Key)' and DeletionMark eq false")
        $select = [uri]::EscapeDataString("Ref_Key,Code,Description,Статус,НачалоДействия,КонецДействия")
        $r = p_OData "Catalog_РесурсныеСпецификации" "`$select=$select&`$filter=$filter&`$top=200&`$orderby=НачалоДействия desc" 120
        if ($r) { $specs = @($r.value) }
    }

    $parentCacheLocal = @{}
    $summaries        = @()
    $rsRowsLocal      = @()
    $materialRowsLocal= @()

    foreach ($sp in $specs) {
        $materials = @()
        $filter = [uri]::EscapeDataString("Ref_Key eq guid'$($sp.Ref_Key)' and substringof('stm', Номенклатура/Артикул)")
        $r = p_OData "Catalog_РесурсныеСпецификации_МатериалыИУслуги" "`$expand=Номенклатура&`$filter=$filter&`$top=500&`$orderby=LineNumber" 120
        if ($r) {
            foreach ($line in @($r.value)) {
                $nom        = $line.Номенклатура
                $article    = if ($nom) { [string]$nom.Артикул } else { "" }
                $matName    = if ($nom) { [string]$nom.Description } else { "" }
                $parentName = ""
                $pk = if ($nom) { ([string]$nom.Parent_Key).Trim() } else { "" }
                if ($pk -ne "" -and $pk -ne "00000000-0000-0000-0000-000000000000") {
                    if ($parentCacheLocal.ContainsKey($pk)) {
                        $parentName = $parentCacheLocal[$pk]
                    } else {
                        $pf = [uri]::EscapeDataString("Ref_Key eq guid'$pk'")
                        $ps = [uri]::EscapeDataString("Ref_Key,Description")
                        $pr = p_OData "Catalog_Номенклатура" "`$select=$ps&`$filter=$pf&`$top=1" 30
                        $parentName = if ($pr -and @($pr.value).Count -gt 0) { [string]@($pr.value)[0].Description } else { "" }
                        $parentCacheLocal[$pk] = $parentName
                    }
                }
                $class = p_Classify $article $parentName $matName
                $qty = 0.0
                try { if ($null -ne $line.КоличествоУпаковок) { $qty = [double]$line.КоличествоУпаковок } } catch {}
                $materials += [pscustomobject]@{
                    specKey=$sp.Ref_Key; lineNumber=[int]$line.LineNumber
                    materialArticle=$article; materialName=$matName; parentFolder=$parentName
                    materialClass=$class; quantityInSpec=$qty
                    supplyMethod=[string]$line.СпособПолученияМатериала
                }
            }
        }

        $rawCount = @($materials | Where-Object { $_.materialClass -eq "Сырье" }).Count
        $matCount = @($materials | Where-Object { $_.materialClass -eq "Материал" }).Count
        $scheme   = p_Scheme $rawCount $matCount $DavThreshold
        $rank     = if ($scheme -eq "Смешанная схема") { 4 } elseif ($scheme -eq "Давальческая: сырье") { 3 } elseif ($scheme -eq "Давальческая схема") { 2 } else { 1 }

        $summary = [pscustomobject]@{
            sku=$s.sku; skuNorm=$s.skuNorm
            productName = if ($n) { [string]$n.Description } else { $s.productName }
            specKey=[string]$sp.Ref_Key; specCode=[string]$sp.Code; specName=[string]$sp.Description
            specStatus=[string]$sp.Статус
            specStart = if ($sp.НачалоДействия) { ([datetime]$sp.НачалоДействия).ToString("yyyy-MM-dd") } else { "" }
            specEnd   = if ($sp.КонецДействия)   { ([datetime]$sp.КонецДействия).ToString("yyyy-MM-dd")   } else { "" }
            davRaw=$rawCount; davMaterials=$matCount; davTotal=$rawCount+$matCount; scheme=$scheme; rank=$rank
        }
        $summaries      += $summary
        $rsRowsLocal    += $summary
        foreach ($m in $materials) {
            $materialRowsLocal += [pscustomobject]@{
                sku=$s.sku; productName=$summary.productName; specKey=$summary.specKey; specCode=$summary.specCode
                lineNumber=$m.lineNumber; materialArticle=$m.materialArticle; materialName=$m.materialName
                parentFolder=$m.parentFolder; materialClass=$m.materialClass
                quantityInSpec=$m.quantityInSpec; supplyMethod=$m.supplyMethod
            }
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

    [pscustomobject]@{
        skuClassRow = [pscustomobject]@{
            sku=$s.sku; skuNorm=$s.skuNorm
            productName    = if ($chosen) { $chosen.productName } else { $s.productName }
            productFound1C = [bool]$n
            specsFound     = $specs.Count
            specKey    = if ($chosen) { $chosen.specKey }    else { "" }
            specCode   = if ($chosen) { $chosen.specCode }   else { "" }
            specStatus = if ($chosen) { $chosen.specStatus } else { "" }
            specStart  = if ($chosen) { $chosen.specStart }  else { "" }
            specEnd    = if ($chosen) { $chosen.specEnd }    else { "" }
            davRaw          = if ($chosen) { $chosen.davRaw }       else { 0 }
            davMaterials    = if ($chosen) { $chosen.davMaterials }  else { 0 }
            davTotal        = if ($chosen) { $chosen.davTotal }      else { 0 }
            hasDavRaw       = if ($chosen) { $chosen.davRaw -gt 0 }                                else { $false }
            hasDavMaterials = if ($chosen) { $chosen.davMaterials -gt 0 }                          else { $false }
            isMixed         = if ($chosen) { $chosen.davRaw -gt 0 -and $chosen.davMaterials -ge $DavThreshold } else { $false }
            scheme = if ($chosen) { $chosen.scheme } elseif ($n) { "РС не найдена" } else { "Не найден артикул в 1С" }
        }
        rsRows       = $rsRowsLocal
        materialRows = $materialRowsLocal
    }
} -ThrottleLimit 8

Write-Host "Aggregating results..."
$skuClassRows  = @($classResults | ForEach-Object { $_.skuClassRow })
$rsRows        = @($classResults | ForEach-Object { $_.rsRows }       | ForEach-Object { $_ })
$materialRows  = @($classResults | ForEach-Object { $_.materialRows } | ForEach-Object { $_ })

$classMap = @{}
foreach ($r in $skuClassRows) { $classMap[$r.skuNorm] = $r }

$salesEnriched = @($sales | ForEach-Object {
    $c = $classMap[$_.skuNorm]
    [pscustomobject]@{
        month=$_.month; year=$_.year; monthNum=$_.monthNum
        customer=$_.customer; manager=$_.manager; brand=$_.brand
        sku=$_.sku
        productName    = if ($c -and $c.productName) { $c.productName } else { $_.productName }
        qty            = [math]::Round($_.qty,3)
        revenue        = [math]::Round($_.revenue,2)
        marginRub      = [math]::Round($_.marginRub,2)
        marginPct      = $_.marginPct
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
    sales         = $salesEnriched
    skuClass      = $skuClassRows
    resourceSpecs = $rsRows
    materials     = $materialRows
}

Write-Host "Writing data.json ($DataPath)..."
$json = $payload | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($DataPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Done. sales=$($sales.Count) skuClass=$($skuClassRows.Count) specs=$($rsRows.Count) materials=$($materialRows.Count)"
