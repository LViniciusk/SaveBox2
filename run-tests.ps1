[CmdletBinding()]
param(
  [ValidateSet('Fast', 'Full')]
  [string]$Profile = 'Full',

  [ValidateRange(1, 4)]
  [int]$BackendShards = 2,

  [switch]$Serial
)

$ErrorActionPreference = 'Stop'

$runner = Join-Path $PSScriptRoot 'tools/quality/run_test_matrix.py'
$arguments = @(
  $runner,
  '--root', $PSScriptRoot,
  '--profile', $Profile,
  '--backend-shards', $BackendShards
)
if ($Serial) {
  $arguments += '--serial'
}

& py @arguments
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
