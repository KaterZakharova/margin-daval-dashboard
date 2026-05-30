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

function Invoke-OData($entity, $query, $timeout = 60) {
    $uri = "$ODataUrl/odata/$([uri]::EscapeDataString($entity))?`$format=json&$query"
    try { return Invoke-RestMethod -Method Get -Uri $uri -Headers $ODataHeaders -TimeoutSec $timeout -ErrorAction Stop }
    catch { return $null }
}

# ── Заказы давальца — не отгруженные позиции из 1С ───────────────────────────
# Документ называется «Заказ Давальца 2.5», но имя в OData может варьироваться
# (точка/пробел нормализуются в подчёркивание). Пробуем несколько кандидатов.
Write-Host "Fetching customer orders (Заказ Давальца 2.5)..."
$orderEntity = $null
$candidates = @(
    "Document_ЗаказДавальца2_5",
    "Document_Заказ_Давальца_2_5",
    "Document_ЗаказДавальца25",
    "Document_ЗаказДавальца",
    "Document_Заказ_Давальца"
)
foreach ($cand in $candidates) {
    $probe = Invoke-OData $cand "`$top=1" 25
    if ($probe -ne $null) { $orderEntity = $cand; Write-Host "  matched entity: $orderEntity"; break }
}
$customerOrders = @()
if ($orderEntity) {
    # Сначала — probe одного заголовка БЕЗ $select, чтобы увидеть все доступные поля
    Write-Host "  --- probing header schema ---"
    $sample = Invoke-OData $orderEntity "`$top=1" 30
    $partnerField = $null
    if ($sample -and @($sample.value).Count -gt 0) {
        $first = @($sample.value)[0]
        $allProps = $first.PSObject.Properties.Name | Sort-Object
        Write-Host "  header fields: $($allProps -join ', ')"
        # ищем поле для контрагента/клиента/партнёра (любое *_Key содержащее ключевые слова)
        $candidates = $allProps | Where-Object { $_ -match '_Key$' -and $_ -match '(Контрагент|Клиент|Партнер|Партнёр|Покупатель|Заказчик|Давалец)' }
        if ($candidates) { $partnerField = $candidates[0]; Write-Host "  partner field detected: $partnerField" }
    }
    if (-not $partnerField) { $partnerField = "Контрагент_Key" }

    # Заголовки заказов за последние 12 мес., только проведённые и не помеченные на удаление
    $sinceDate = (Get-Date).AddMonths(-12).ToString("yyyy-MM-ddTHH:mm:ss")
    $hdrFilter = [uri]::EscapeDataString("Date ge datetime'$sinceDate' and Posted eq true and DeletionMark eq false")
    $hdrSelect = [uri]::EscapeDataString("Ref_Key,Number,Date,$partnerField")
    $hdrR = Invoke-OData $orderEntity "`$select=$hdrSelect&`$filter=$hdrFilter&`$top=5000&`$orderby=Date desc" 180
    $headers = if ($hdrR) { @($hdrR.value) } else { @() }
    Write-Host "  orders headers: $($headers.Count)"

    # Имя табличной части — берём ВСЕ дочерние коллекции из OData service document.
    # Выбираем ту, у которой SKU максимально пересекаются с SKU продаж — это
    # реальная готовая продукция (а не материалы/упаковка/услуги).
    $salesSkuSet = New-Object System.Collections.Generic.HashSet[string]
    foreach ($s in $sales) { [void]$salesSkuSet.Add([string]$s.sku) }

    $tabEntities = @()
    try {
        $svcUri = "$ODataUrl/odata/?`$format=json"
        $svc = Invoke-RestMethod -Method Get -Uri $svcUri -Headers $ODataHeaders -TimeoutSec 30 -ErrorAction Stop
        if ($svc -and $svc.value) {
            $children = @($svc.value | Where-Object { $_.name -like "${orderEntity}_*" } | ForEach-Object { $_.name } | Sort-Object -Unique)
            Write-Host "  child collections of ${orderEntity} ($($children.Count)):"
            foreach ($cn in $children) { Write-Host "    - $cn" }
            $tabEntities = $children
        }
    } catch {
        Write-Host "  service document not available, falling back to guesses"
        $tabEntities = @("${orderEntity}_Товары","${orderEntity}_СписокНоменклатуры","${orderEntity}_Номенклатура","${orderEntity}_Состав","${orderEntity}_СписокТоваров","${orderEntity}_Изделия","${orderEntity}_Продукция","${orderEntity}_Запасы","${orderEntity}_Спецификация","${orderEntity}_Материалы")
    }

    # Для каждого кандидата берём первые 200 строк с Номенклатурой → считаем
    # пересечение артикулов с sales. Та коллекция что даёт больше всего совпадений —
    # это готовая продукция (то что заказывает давалец на производство).
    $best = $null
    foreach ($t in $tabEntities) {
        $probe = Invoke-OData $t "`$top=200&`$expand=Номенклатура" 30
        if ($probe -eq $null -or @($probe.value).Count -eq 0) { Write-Host "    probe $t : пусто"; continue }
        $first = @($probe.value)[0]
        $hasNom = ($first.PSObject.Properties.Name -contains "Номенклатура_Key") -or ($first.PSObject.Properties.Name -contains "Номенклатура")
        if (-not $hasNom) { Write-Host "    probe $t : нет поля Номенклатура"; continue }
        $hits = 0
        foreach ($line in @($probe.value)) {
            $nom = $line.Номенклатура
            if (-not $nom) { continue }
            $art = ([string]$nom.Артикул).Trim()
            if ([string]::IsNullOrEmpty($art)) { continue }
            if ($salesSkuSet.Contains($art)) { $hits++ }
        }
        Write-Host "    probe $t : $($probe.value.Count) строк, $hits совпадений с sales SKU"
        if (-not $best -or $hits -gt $best.hits) { $best = @{ entity = $t; hits = $hits } }
    }
    $tabEntity = if ($best -and $best.hits -gt 0) { $best.entity } else { $null }
    if ($tabEntity) { Write-Host "  matched line entity: $tabEntity (по пересечению SKU с продажами: $($best.hits))" }
    else            { Write-Host "  could not find table with sales-matching SKU among children" }

    if ($tabEntity -and $headers.Count -gt 0) {
        # Имя контрагента: тянем из нескольких каталогов (Контрагенты / Партнеры / Клиенты).
        # Имя поля динамическое — определилось выше как $partnerField.
        $custMap = @{}
        $custKeys = @($headers | ForEach-Object { [string]$_.$partnerField } | Where-Object { $_ -and $_ -ne "00000000-0000-0000-0000-000000000000" } | Select-Object -Unique)
        Write-Host "  unique partner keys in orders: $($custKeys.Count) (field=$partnerField)"
        if ($custKeys.Count -gt 0) {
            # Подбираем правильный каталог: пробуем несколько кандидатов
            $partnerCatalogs = @("Catalog_Контрагенты","Catalog_Партнеры","Catalog_Клиенты","Catalog_Покупатели","Catalog_Заказчики","Catalog_Давальцы")
            foreach ($cat in $partnerCatalogs) {
                $probe = Invoke-OData $cat "`$top=1" 20
                if ($probe -eq $null) { continue }
                Write-Host "    catalog $cat exists, batching $($custKeys.Count) lookups..."
                $found = 0
                for ($i = 0; $i -lt $custKeys.Count; $i += 50) {
                    $batch = $custKeys[$i..([Math]::Min($i+49,$custKeys.Count-1))]
                    $orParts = $batch | ForEach-Object { "Ref_Key eq guid'$_'" }
                    $f = [uri]::EscapeDataString( ($orParts -join " or ") )
                    $sel = [uri]::EscapeDataString("Ref_Key,Description")
                    $r = Invoke-OData $cat "`$select=$sel&`$filter=$f&`$top=200" 60
                    if ($r) { foreach ($c in @($r.value)) { if (-not $custMap.ContainsKey([string]$c.Ref_Key)) { $custMap[[string]$c.Ref_Key] = [string]$c.Description; $found++ } } }
                }
                Write-Host "    $cat resolved: $found"
                if ($custMap.Count -eq $custKeys.Count) { break }    # все нашли — хватит
            }
            Write-Host "  partner names resolved: $($custMap.Count) / $($custKeys.Count)"
        }

        # Идём по каждому заказу и тянем строки
        $i = 0; $tot = $headers.Count
        foreach ($h in $headers) {
            $i++; if ($i % 50 -eq 0) { Write-Host "    orders $i/$tot" }
            $lf = [uri]::EscapeDataString("Ref_Key eq guid'$($h.Ref_Key)'")
            $lr = Invoke-OData $tabEntity "`$expand=Номенклатура&`$filter=$lf&`$top=500" 60
            if (-not $lr) { continue }
            $custName = $custMap[[string]$h.$partnerField]
            if (-not $custName) { $custName = "" }
            $dateStr = ([datetime]$h.Date).ToString("yyyy-MM-dd")
            $monthStr = ([datetime]$h.Date).ToString("yyyy-MM")
            foreach ($line in @($lr.value)) {
                $nom = $line.Номенклатура
                if (-not $nom) { continue }
                $sku = ([string]$nom.Артикул)
                if ([string]::IsNullOrWhiteSpace($sku)) { continue }
                $qty = 0.0
                try { if ($null -ne $line.Количество) { $qty = [double]$line.Количество } } catch {}
                if ($qty -le 0) { continue }
                $customerOrders += [pscustomobject]@{
                    sku       = $sku
                    customer  = $custName
                    qty       = [math]::Round($qty, 3)
                    date      = $dateStr
                    month     = $monthStr
                    docNumber = [string]$h.Number
                }
            }
        }
        Write-Host "  orders rows: $($customerOrders.Count)"
    } else {
        Write-Host "  could not find table entity for $orderEntity — skipping"
    }
} else {
    Write-Host "  Заказ Давальца entity not found in OData — skipping (try fixing entity name in script)"
}

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
        orderEntity      = $orderEntity
        ordersCount      = $customerOrders.Count
    }
    sales         = $salesEnriched
    skuClass      = $skuClassRows
    resourceSpecs = $rsRows
    materials     = $materialRows
    orders        = $customerOrders
}

Write-Host "Writing data.json ($DataPath)..."
$json = $payload | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($DataPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Done. sales=$($sales.Count) skuClass=$($skuClassRows.Count) specs=$($rsRows.Count) materials=$($materialRows.Count) orders=$($customerOrders.Count)"
