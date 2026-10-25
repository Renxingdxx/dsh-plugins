# Native "pick a media file" dialog for the dsh-custom-splash settings page.
#
# Spawned by the plugin's Host half. Windows ships WinForms with the .NET runtime
# PowerShell already loads, so this needs no dependency and no install step.
#
# Contract with the caller:
#   - STA is required: the common file dialog is a COM object and throws on an
#     MTA thread. Windows PowerShell 5.1 defaults to STA, but `pwsh` 7 defaults
#     to MTA, so -STA is passed explicitly.
#   - The selected path is written to -OutFile as UTF-8, NOT to stdout. A console
#     writes text through the system ANSI code page (GBK on a Chinese Windows),
#     so a path with non-ASCII characters comes back as mojibake when the caller
#     decodes it as UTF-8. A file carries its own encoding.
#   - Nothing is written when the user cancels, so "no file" means cancel.
#   - Diagnostics go to stderr, never into the result.
#   - Exit code 0 covers both "picked" and "cancelled"; a non-zero code means the
#     dialog itself failed.

param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [ValidateSet('any', 'picture', 'sound')][string]$Kind = 'any',
  [string]$InitialDirectory = '',
  [string]$InitialFile = ''
)

$ErrorActionPreference = 'Stop'

$video = 'Video (*.webm;*.mp4;*.m4v;*.mov;*.mkv;*.ogv;*.ogm;*.mpg;*.mpeg;*.ts)|*.webm;*.mp4;*.m4v;*.mov;*.mkv;*.ogv;*.ogm;*.mpg;*.mpeg;*.ts'
$image = 'Animated / still image (*.gif;*.apng;*.webp;*.avif;*.png;*.jpg;*.jpeg;*.svg;*.bmp;*.ico)|*.gif;*.apng;*.webp;*.avif;*.png;*.jpg;*.jpeg;*.svg;*.bmp;*.ico'
$audio = 'Audio (*.wav;*.mp3;*.ogg;*.oga;*.opus;*.m4a;*.aac;*.flac;*.webma;*.weba)|*.wav;*.mp3;*.ogg;*.oga;*.opus;*.m4a;*.aac;*.flac;*.webma;*.weba'
$allPicture = 'All supported picture (*.webm;*.mp4;*.m4v;*.mov;*.mkv;*.ogv;*.ogm;*.mpg;*.mpeg;*.ts;*.gif;*.apng;*.webp;*.avif;*.png;*.jpg;*.jpeg;*.svg;*.bmp;*.ico)|*.webm;*.mp4;*.m4v;*.mov;*.mkv;*.ogv;*.ogm;*.mpg;*.mpeg;*.ts;*.gif;*.apng;*.webp;*.avif;*.png;*.jpg;*.jpeg;*.svg;*.bmp;*.ico'

switch ($Kind) {
  'picture' { $dialogFilter = "$allPicture|$video|$image|All files (*.*)|*.*" }
  'sound'   { $dialogFilter = "$audio|All files (*.*)|*.*" }
  default   { $dialogFilter = "$allPicture|$video|$image|$audio|All files (*.*)|*.*" }
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  switch ($Kind) {
    'picture' { $dialog.Title = 'Select a picture for the DSH splash' }
    'sound'   { $dialog.Title = 'Select a sound for the DSH splash' }
    default   { $dialog.Title = 'Select media for the DSH splash' }
  }
  $dialog.CheckFileExists = $true
  $dialog.CheckPathExists = $true
  $dialog.Multiselect = $false
  $dialog.RestoreDirectory = $true
  $dialog.Filter = $dialogFilter

  if ($InitialDirectory -ne '' -and (Test-Path -LiteralPath $InitialDirectory)) {
    $dialog.InitialDirectory = $InitialDirectory
  }
  if ($InitialFile -ne '') {
    $dialog.FileName = $InitialFile
  }

  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.WindowState = 'Minimized'
  $owner.ShowInTaskbar = $false
  $owner.Opacity = 0

  $result = $dialog.ShowDialog($owner)
  $owner.Dispose()

  if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.FileName -ne '') {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($OutFile, $dialog.FileName, $utf8NoBom)
  }
  $dialog.Dispose()
  exit 0
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
