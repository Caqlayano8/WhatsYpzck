# Author: C.Kurtoglu
# Description: Small GUI app to generate signed customer license files.

param(
    [string]$WorkspacePath = "",
    [string]$DefaultPrivateKeyPath = "",
    [string]$DefaultOutputPath = ""
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function New-Label([string]$text, [int]$x, [int]$y, [int]$w = 140) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text
    $l.Location = New-Object System.Drawing.Point($x, $y)
    $l.Size = New-Object System.Drawing.Size($w, 22)
    return $l
}

function New-TextBox([int]$x, [int]$y, [int]$w = 520) {
    $t = New-Object System.Windows.Forms.TextBox
    $t.Location = New-Object System.Drawing.Point($x, $y)
    $t.Size = New-Object System.Drawing.Size($w, 24)
    return $t
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "WhatsYpzck - Lisans Uretici"
$form.Size = New-Object System.Drawing.Size(760, 500)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false

$defaultWorkspace = if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { (Get-Location).Path } else { $WorkspacePath }
$defaultPrivate = if ([string]::IsNullOrWhiteSpace($DefaultPrivateKeyPath)) { Join-Path $defaultWorkspace "licenses\private.pem" } else { $DefaultPrivateKeyPath }
$defaultOutput = if ([string]::IsNullOrWhiteSpace($DefaultOutputPath)) { Join-Path $defaultWorkspace "licenses\license.key.json" } else { $DefaultOutputPath }

$lblWorkspace = New-Label "Workspace Path" 20 20 120
$txtWorkspace = New-TextBox 150 18 500
$txtWorkspace.Text = $defaultWorkspace
$btnWorkspace = New-Object System.Windows.Forms.Button
$btnWorkspace.Text = "Sec"
$btnWorkspace.Location = New-Object System.Drawing.Point(660, 18)
$btnWorkspace.Size = New-Object System.Drawing.Size(70, 24)

$lblPrivate = New-Label "Private Key" 20 60 120
$txtPrivate = New-TextBox 150 58 500
$txtPrivate.Text = $defaultPrivate
$btnPrivate = New-Object System.Windows.Forms.Button
$btnPrivate.Text = "Sec"
$btnPrivate.Location = New-Object System.Drawing.Point(660, 58)
$btnPrivate.Size = New-Object System.Drawing.Size(70, 24)

$lblOutput = New-Label "Lisans Cikti" 20 100 120
$txtOutput = New-TextBox 150 98 500
$txtOutput.Text = $defaultOutput
$btnOutput = New-Object System.Windows.Forms.Button
$btnOutput.Text = "Sec"
$btnOutput.Location = New-Object System.Drawing.Point(660, 98)
$btnOutput.Size = New-Object System.Drawing.Size(70, 24)

$lblCustomerId = New-Label "Customer ID" 20 150 120
$txtCustomerId = New-TextBox 150 148 220
$txtCustomerId.Text = "CEDA-001"

$lblCustomerName = New-Label "Customer Name" 390 150 120
$txtCustomerName = New-TextBox 510 148 220
$txtCustomerName.Text = "Coruh EDAS"

$lblIssuedAt = New-Label "Issued At (ISO)" 20 190 120
$txtIssuedAt = New-TextBox 150 188 220
$txtIssuedAt.Text = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

$lblExpiresAt = New-Label "Expires At (ISO)" 390 190 120
$txtExpiresAt = New-TextBox 510 188 220
$txtExpiresAt.Text = (Get-Date).ToUniversalTime().AddYears(1).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

$lblFeatures = New-Label "Features (,)" 20 230 120
$txtFeatures = New-TextBox 150 228 580
$txtFeatures.Text = ""

$btnKeyPair = New-Object System.Windows.Forms.Button
$btnKeyPair.Text = "Key Pair Olustur"
$btnKeyPair.Location = New-Object System.Drawing.Point(150, 270)
$btnKeyPair.Size = New-Object System.Drawing.Size(160, 32)

$btnGenerate = New-Object System.Windows.Forms.Button
$btnGenerate.Text = "Lisans Uret"
$btnGenerate.Location = New-Object System.Drawing.Point(320, 270)
$btnGenerate.Size = New-Object System.Drawing.Size(160, 32)

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = "Kapat"
$btnClose.Location = New-Object System.Drawing.Point(490, 270)
$btnClose.Size = New-Object System.Drawing.Size(160, 32)

$txtLog = New-Object System.Windows.Forms.TextBox
$txtLog.Location = New-Object System.Drawing.Point(20, 320)
$txtLog.Multiline = $true
$txtLog.ScrollBars = "Vertical"
$txtLog.ReadOnly = $true
$txtLog.Size = New-Object System.Drawing.Size(710, 130)

$form.Controls.AddRange(@(
    $lblWorkspace, $txtWorkspace, $btnWorkspace,
    $lblPrivate, $txtPrivate, $btnPrivate,
    $lblOutput, $txtOutput, $btnOutput,
    $lblCustomerId, $txtCustomerId,
    $lblCustomerName, $txtCustomerName,
    $lblIssuedAt, $txtIssuedAt,
    $lblExpiresAt, $txtExpiresAt,
    $lblFeatures, $txtFeatures,
    $btnKeyPair, $btnGenerate, $btnClose,
    $txtLog
))

function Write-Log([string]$line) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $txtLog.AppendText("[$ts] $line`r`n")
}

$btnWorkspace.Add_Click({
    $fb = New-Object System.Windows.Forms.FolderBrowserDialog
    if ($fb.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $txtWorkspace.Text = $fb.SelectedPath
    }
})

$btnPrivate.Add_Click({
    $ofd = New-Object System.Windows.Forms.OpenFileDialog
    $ofd.Filter = "PEM files (*.pem)|*.pem|All files (*.*)|*.*"
    if ($ofd.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $txtPrivate.Text = $ofd.FileName
    }
})

$btnOutput.Add_Click({
    $sfd = New-Object System.Windows.Forms.SaveFileDialog
    $sfd.Filter = "JSON files (*.json)|*.json|All files (*.*)|*.*"
    $sfd.FileName = "license.key.json"
    if ($sfd.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $txtOutput.Text = $sfd.FileName
    }
})

$btnKeyPair.Add_Click({
    try {
        $ws = $txtWorkspace.Text.Trim()
        if ([string]::IsNullOrWhiteSpace($ws) -or -not (Test-Path $ws)) {
            [System.Windows.Forms.MessageBox]::Show("Workspace path gecersiz.", "Hata") | Out-Null
            return
        }

        Write-Log "Key pair olusturma basladi..."
        Push-Location $ws
        try {
            $output = & npm.cmd run license:keypair 2>&1 | Out-String
            Write-Log ($output.Trim())
            $txtPrivate.Text = Join-Path $ws "licenses\private.pem"
            if ([string]::IsNullOrWhiteSpace($txtOutput.Text.Trim())) {
                $txtOutput.Text = Join-Path $ws "licenses\license.key.json"
            }
            [System.Windows.Forms.MessageBox]::Show("Key pair olusturuldu.", "Basarili") | Out-Null
        } finally {
            Pop-Location
        }
    } catch {
        Write-Log ("HATA: " + $_.Exception.Message)
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Hata") | Out-Null
    }
})

$btnGenerate.Add_Click({
    try {
        $ws = $txtWorkspace.Text.Trim()
        $privateKey = $txtPrivate.Text.Trim()
        $outputFile = $txtOutput.Text.Trim()
        $customerId = $txtCustomerId.Text.Trim()
        $customerName = $txtCustomerName.Text.Trim()
        $issuedAt = $txtIssuedAt.Text.Trim()
        $expiresAt = $txtExpiresAt.Text.Trim()
        $features = $txtFeatures.Text.Trim()

        if ([string]::IsNullOrWhiteSpace($ws) -or -not (Test-Path $ws)) {
            [System.Windows.Forms.MessageBox]::Show("Workspace path gecersiz.", "Hata") | Out-Null
            return
        }
        if ([string]::IsNullOrWhiteSpace($privateKey) -or -not (Test-Path $privateKey)) {
            [System.Windows.Forms.MessageBox]::Show("Private key dosyasi bulunamadi.", "Hata") | Out-Null
            return
        }
        if ([string]::IsNullOrWhiteSpace($customerId) -or [string]::IsNullOrWhiteSpace($customerName) -or [string]::IsNullOrWhiteSpace($expiresAt)) {
            [System.Windows.Forms.MessageBox]::Show("CustomerId, CustomerName ve ExpiresAt zorunludur.", "Hata") | Out-Null
            return
        }

        $outDir = Split-Path -Parent $outputFile
        if (-not (Test-Path $outDir)) {
            New-Item -ItemType Directory -Path $outDir -Force | Out-Null
        }

        $args = @(
            "run", "license:generate", "--",
            "--customerId", $customerId,
            "--customerName", $customerName,
            "--issuedAt", $issuedAt,
            "--expiresAt", $expiresAt,
            "--privateKey", $privateKey,
            "--output", $outputFile
        )

        if (-not [string]::IsNullOrWhiteSpace($features)) {
            $args += @("--features", $features)
        }

        Write-Log "Lisans uretimi basladi..."
        Push-Location $ws
        try {
            $output = & npm.cmd @args 2>&1 | Out-String
            Write-Log ($output.Trim())
        } finally {
            Pop-Location
        }

        [System.Windows.Forms.MessageBox]::Show("Lisans dosyasi olusturuldu:`n$outputFile", "Basarili") | Out-Null
    } catch {
        Write-Log ("HATA: " + $_.Exception.Message)
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Hata") | Out-Null
    }
})

$btnClose.Add_Click({ $form.Close() })

Write-Log "Lisans uretici hazir."
[void]$form.ShowDialog()
