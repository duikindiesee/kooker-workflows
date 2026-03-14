param(
    [string]$grafanaUrl = "http://grafana.kooker.co.za",
    [string]$pat = $env:KOOKER_GRAFANA_PAT
)

if ([string]::IsNullOrWhiteSpace($pat)) {
    Write-Error "KOOKER_GRAFANA_PAT is not set. Please set the environment variable before running this script."
    exit 1
}

$headers = @{
    "Authorization" = "Bearer $pat"
    "Content-Type"  = "application/json"
    "Accept"        = "application/json"
}

# Mapping of popular Grafana IDs
# 315   - Kubernetes cluster monitoring (via Prometheus)
# 4701  - JVM (Micrometer)
# 7362  - MySQL Overview
# 11378 - Spring Boot Stats
$dashboards = @(315, 4701, 7362, 11378)

foreach ($id in $dashboards) {
    Write-Host "Fetching dashboard ID $id from grafana.com..."
    try {
        $response = Invoke-RestMethod -Uri "https://grafana.com/api/dashboards/$id/revisions/latest/download" -Method Get
        
        # Grafana's API requires the JSON to be wrapped in a 'dashboard' key
        $payloadObj = @{
            dashboard = $response
            overwrite = $true
        }
        
        $payloadJson = $payloadObj | ConvertTo-Json -Depth 20
        
        Write-Host "Importing dashboard ID $id into $grafanaUrl..."
        $importResult = Invoke-RestMethod -Uri "$grafanaUrl/api/dashboards/db" -Headers $headers -Method Post -Body $payloadJson
        
        Write-Host "Successfully imported dashboard $id!" -ForegroundColor Green
    }
    catch {
        Write-Error "Failed to process dashboard $id. Error: $($_.Exception.Message)"
    }
}

Write-Host "All done!"
