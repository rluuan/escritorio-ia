# Escritório IA na bandeja do Windows.
# Mantém o coletor (node server.mjs) rodando sem janela e mostra um ícone perto do relógio
# com "Abrir escritório", "Ver registro", "Reiniciar" e "Sair".
#   -Ativar     cria o atalho na pasta Inicializar do usuário e abre a bandeja
#   -Desativar  remove esse atalho
param([switch]$Ativar, [switch]$Desativar)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing, Microsoft.VisualBasic
$dir = $PSScriptRoot
Set-Location $dir
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Escritorio IA.lnk'
$argsBandeja = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dir\bandeja.ps1`""

function Aviso($texto) { [System.Windows.Forms.MessageBox]::Show($texto, 'Escritório IA') | Out-Null }

if ($Desativar) {
  if (Test-Path $lnk) { Remove-Item $lnk }
  Aviso 'O escritório não abre mais sozinho quando o Windows liga.'
  exit
}
if ($Ativar) {
  $sh = New-Object -ComObject WScript.Shell
  $l = $sh.CreateShortcut($lnk)
  $l.TargetPath = (Get-Command powershell.exe).Source
  $l.Arguments = $argsBandeja
  $l.WorkingDirectory = $dir
  $l.WindowStyle = 7
  $l.Description = 'Escritório IA (ícone na bandeja)'
  $l.Save()
  Start-Process powershell.exe -ArgumentList $argsBandeja -WindowStyle Hidden
  Aviso "Pronto. O escritório vai abrir sozinho quando o Windows ligar.`nO ícone fica perto do relógio (às vezes escondido na setinha ^)."
  exit
}

# uma bandeja só por usuário
$criado = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\EscritorioIA-Bandeja', [ref]$criado)
if (-not $criado) { exit }

# Node: o portátil dentro da pasta tem preferência
$node = Join-Path $dir 'node\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $node) { Aviso 'O Node.js não foi encontrado. Instale a versão LTS em https://nodejs.org'; exit 1 }

# nome no escritório (primeira vez)
$cfgPath = Join-Path $dir 'config.json'
$cfg = $null
if (Test-Path $cfgPath) { try { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {} }
if (-not $cfg) { $cfg = [pscustomobject]@{ port = 4480; showText = $true; peers = @() } }
if (-not $cfg.owner) {
  $nome = [Microsoft.VisualBasic.Interaction]::InputBox('Seu nome no escritório:', 'Escritório IA', $env:USERNAME)
  if (-not $nome.Trim()) { exit }
  $cfg | Add-Member -NotePropertyName owner -NotePropertyValue $nome.Trim() -Force
  [IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
}
$port = if ($cfg.port) { $cfg.port } else { 4480 }

# registro: recomeça quando passa de 1 MB
$log = Join-Path $dir 'escritorio.log'
if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Remove-Item $log }

$script:proc = $null
$script:saindo = $false
function Iniciar-Coletor {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = '--no-warnings server.mjs'
  $psi.WorkingDirectory = $dir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['ESCRITORIO_SUPERVISOR'] = '1'
  $psi.EnvironmentVariables['ESCRITORIO_LOG'] = $log
  $script:proc = [System.Diagnostics.Process]::Start($psi)
  $script:inicio = Get-Date
}
$script:tentativas = 0
$script:tentarEm = $null
function Parar-Coletor {
  if ($script:proc -and -not $script:proc.HasExited) { $script:proc.Kill(); $script:proc.WaitForExit(3000) | Out-Null }
}

# ícone desenhado na hora: quadrado laranja com uma telinha
$bmp = New-Object System.Drawing.Bitmap 32, 32
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(224, 122, 82))), 1, 1, 30, 30)
$g.FillRectangle([System.Drawing.Brushes]::White, 8, 9, 16, 11)
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(47, 181, 162))), 10, 11, 12, 7)
$g.FillRectangle([System.Drawing.Brushes]::White, 6, 21, 20, 3)
$g.Dispose()
$icone = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icone
$tray.Text = 'Escritório IA'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$abrir = $menu.Items.Add('Abrir escritório')
$abrir.Font = New-Object System.Drawing.Font($abrir.Font, [System.Drawing.FontStyle]::Bold)
$registro = $menu.Items.Add('Ver registro')
$reiniciar = $menu.Items.Add('Reiniciar')
[void]$menu.Items.Add('-')
$sair = $menu.Items.Add('Sair')
$tray.ContextMenuStrip = $menu

$abrirPagina = { Start-Process "http://localhost:$port" }
$abrir.add_Click($abrirPagina)
$tray.add_DoubleClick($abrirPagina)
$registro.add_Click({ if (Test-Path $log) { Start-Process notepad.exe $log } })
$reiniciar.add_Click({ Parar-Coletor; $script:tentativas = 0; $script:tentarEm = $null; Start-Sleep -Milliseconds 800; Iniciar-Coletor; $tray.Text = 'Escritório IA' })
$sair.add_Click({
  $script:saindo = $true
  Parar-Coletor
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

# vigia o coletor: código 42 = acabou de se atualizar, reabre na hora.
# Se ele cair logo depois de abrir (ex.: porta ainda presa pelo anterior), tenta de novo até 5 vezes.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
  if ($script:saindo) { return }
  if ($script:tentarEm -and (Get-Date) -ge $script:tentarEm) { $script:tentarEm = $null; Iniciar-Coletor; return }
  if (-not $script:proc) { return }
  if (-not $script:proc.HasExited) {
    if (((Get-Date) - $script:inicio).TotalSeconds -gt 60) { $script:tentativas = 0 }
    return
  }
  $codigo = $script:proc.ExitCode
  $durou = ((Get-Date) - $script:inicio).TotalSeconds
  $script:proc = $null
  if ($codigo -eq 42) {
    Iniciar-Coletor
    $tray.ShowBalloonTip(4000, 'Escritório IA', 'Atualizado para a versão nova.', 'Info')
  } elseif ($durou -lt 30 -and $script:tentativas -lt 5) {
    $script:tentativas++
    $script:tentarEm = (Get-Date).AddSeconds(3)
    $tray.Text = 'Escritório IA (abrindo de novo...)'
  } else {
    $tray.Text = 'Escritório IA (parado)'
    $tray.ShowBalloonTip(8000, 'Escritório IA parou', "Código $codigo. Clique com o botão direito e veja o registro, ou use Reiniciar.", 'Warning')
  }
})

Iniciar-Coletor
$tray.Visible = $true
$timer.Start()
[System.Windows.Forms.Application]::Run()
$timer.Stop()
$tray.Dispose()
$mutex.ReleaseMutex()
