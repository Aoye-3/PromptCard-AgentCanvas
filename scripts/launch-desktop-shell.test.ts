import { describe, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const scriptPath = path.resolve(__dirname, 'launch-desktop-shell.ps1')
const rustMainPath = path.resolve(__dirname, '..', 'src-tauri', 'src', 'main.rs')
const rustLibPath = path.resolve(__dirname, '..', 'src-tauri', 'src', 'lib.rs')
const capabilityPath = path.resolve(__dirname, '..', 'src-tauri', 'capabilities', 'default.json')

function runPowerShellCommand(command: string) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-Command', command], {
      cwd: path.resolve(__dirname, '..'),
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => resolve({ stdout, stderr, code }))
  })
}

describe('launch-desktop-shell.ps1', () => {
  test('uses a current desktop executable as the fast launch path', async () => {
    const script = await readFile(scriptPath, 'utf8')

    expect(script).toContain('Test-DesktopShellCurrent')
    expect(script).toContain('Starting current desktop shell directly')
    expect(script).toContain('$DesktopShellExecutable')
  })

  test('requires a source fingerprint stamp before reusing the debug executable', async () => {
    const script = await readFile(scriptPath, 'utf8')

    expect(script).toContain('$DesktopShellBuildStampPath')
    expect(script).toContain('Get-DesktopShellSourceFingerprint')
    expect(script).toContain('Get-DesktopShellSourceFiles')
    expect(script).toContain('sourceFingerprint')
    expect(script).toContain('Write-DesktopShellBuildStamp')
    expect(script).toContain('src-tauri\\tauri.conf.json')
    expect(script).toContain('src-tauri\\capabilities\\default.json')
    expect(script).toContain('src-tauri\\capabilities\\capture-toolbar.json')
  })

  test('computes the source fingerprint without relying on Get-FileHash', async () => {
    const escapedScriptPath = scriptPath.replace(/'/g, "''")
    const escapedRepoRoot = path.resolve(__dirname, '..').replace(/'/g, "''")
    const command = [
      'Import-Module Microsoft.PowerShell.Management',
      'Import-Module Microsoft.PowerShell.Utility',
      "function global:Get-FileHash { throw 'Get-FileHash unavailable' }",
      '$taskTokens = $null',
      '$taskErrors = $null',
      `$taskAst = [System.Management.Automation.Language.Parser]::ParseFile('${escapedScriptPath}', [ref]$taskTokens, [ref]$taskErrors)`,
      "if ($taskErrors.Count -gt 0) { $taskErrors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
      "$taskNames = @('Get-DesktopShellSourceFiles', 'Get-DesktopShellSourceFingerprint')",
      '$taskFunctions = $taskAst.FindAll({ param($taskNode) $taskNode -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $taskNames -contains $taskNode.Name }, $true)',
      'foreach ($taskFunction in $taskFunctions) { . ([scriptblock]::Create($taskFunction.Extent.Text)) }',
      `$RepoRoot = Resolve-Path '${escapedRepoRoot}'`,
      '$taskFingerprint = Get-DesktopShellSourceFingerprint',
      "if ($taskFingerprint -notmatch '^[0-9a-f]{64}$') { Write-Error \"Invalid fingerprint: $taskFingerprint\"; exit 1 }",
      'Write-Output $taskFingerprint'
    ].join('; ')

    const result = await runPowerShellCommand(command)

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{64}$/)
  })

  test('serializes desktop launches to prevent duplicate toolbar windows', async () => {
    const script = await readFile(scriptPath, 'utf8')

    expect(script).toContain('PromptCardManagerDesktopShellLaunch')
    expect(script).toContain('$LaunchMutex.WaitOne(0)')
    expect(script).toContain('launch is already in progress')
    expect(script).toContain('$LaunchMutex.ReleaseMutex()')
  })

  test('restores an existing desktop window instead of silently exiting', async () => {
    const script = await readFile(scriptPath, 'utf8')

    expect(script).toContain('Show-DesktopShellWindow')
    expect(script).toContain('Get-ExistingDesktopShellWindow')
    expect(script).toContain('DesktopWindowInterop')
    expect(script).toContain('GetTopLevelWindows')
    expect(script).toContain('ShowWindowAsync')
    expect(script).toContain('SetForegroundWindow')
    expect(script).not.toContain('MainWindowHandle')
    expect(script).not.toContain('AppActivate')
    expect(script).toContain('restored the existing window')
  })

  test('only treats a visible full-size main window as reusable', async () => {
    const script = await readFile(scriptPath, 'utf8')

    expect(script).toContain('$DesktopMainWindowTitle = "PromptCard Manager Dev Shell"')
    expect(script).toContain('$DesktopMinMainWindowWidth = 400')
    expect(script).toContain('$DesktopMinMainWindowHeight = 300')
    expect(script).toContain('$_.Visible')
    expect(script).toContain('$_.Title -eq $DesktopMainWindowTitle')
    expect(script).toContain('$_.Width -ge $DesktopMinMainWindowWidth')
    expect(script).toContain('$_.Height -ge $DesktopMinMainWindowHeight')
  })

  test('cleans stale current-repo shell processes before relaunching', async () => {
    const script = await readFile(scriptPath, 'utf8')

    expect(script).toContain('Get-CurrentDesktopShellProcesses')
    expect(script).toContain('ExecutablePath')
    expect(script).toContain('$DesktopShellExecutable')
    expect(script).toContain('Stop-StaleDesktopShellProcesses')
    expect(script).toContain('no main window was found')
    expect(script).toContain('Stop-Process -Id $process.ProcessId -Force')
  })

  test('waits for frontend readiness and then waits for a real desktop main window', async () => {
    const script = await readFile(scriptPath, 'utf8')

    expect(script).toContain('Wait-DevRuntimeHealthy')
    expect(script).toContain('Read-PromptCardDevRuntime')
    expect(script).toContain('Desktop shell requires rebuild; starting tauri dev')
    expect(script).toContain('Write-TauriDevRuntimeConfig')
    expect(script).toContain('Wait-DesktopShellProcess')
    expect(script).toContain('$mainWindow = Get-ExistingDesktopShellWindow')
    expect(script).toContain('Show-DesktopShellWindow $mainWindow')
  })

  test('starts local services in the background before opening the desktop shell', async () => {
    const script = await readFile(scriptPath, 'utf8')

    expect(script).toContain('$StartDevWithAgentScript')
    expect(script).toContain('-ServicesOnly')
    expect(script).toContain('$servicesOutput = & powershell')
    expect(script).toContain('Set-Content -LiteralPath $DesktopServicesOutLog')
    expect(script).toContain('Local services failed to start')
    expect(script).toContain('vite-frontend.err.log')
    expect(script).toContain('tauri-dev.err.log')
    expect(script).toContain('Start-HiddenLoggedCommand')
    expect(script).toContain('Stop-StaleFrontendProcesses')
    expect(script).toContain('Stopping stale Vite frontend process')
    expect(script).toContain('$env:PROMPTCARD_DESKTOP_DEV = "1"')
    expect(script).toContain('Starting or reusing local services in the background')
    expect(script).toContain('Starting Vite frontend')
  })

  test('initializes the protected desktop profile before starting local services', async () => {
    const launchScript = await readFile(scriptPath, 'utf8')
    const profileScript = await readFile(path.resolve(__dirname, 'start-desktop-dev-services.ps1'), 'utf8')

    expect(launchScript).toContain('$StartDesktopDevServicesScript')
    expect(launchScript).toContain('. $StartDesktopDevServicesScript -InitializeOnly')
    expect(profileScript).toContain('[switch]$InitializeOnly')
    expect(profileScript).toContain('$env:PROMPTCARD_DESKTOP_PROFILE_ROOT = $ProfileRoot')
    expect(profileScript).toContain('$env:PROMPTCARD_STORAGE_DATA_DIR = $DataDir')
    expect(profileScript).toContain('$env:PROMPTCARD_LOGS_DIR = $LogsDir')
    expect(profileScript).toContain('$env:PROMPTCARD_RUNTIME_STATE_DIR = $RuntimeStateDir')

    const initializeProfileAt = launchScript.indexOf('. $StartDesktopDevServicesScript -InitializeOnly')
    const startServicesAt = launchScript.indexOf('$servicesOutput = & powershell')
    expect(initializeProfileAt).toBeGreaterThanOrEqual(0)
    expect(startServicesAt).toBeGreaterThan(initializeProfileAt)
  })

  test('requires the frontend health check to identify the PromptCard app', async () => {
    const runtimeScript = await readFile(path.resolve(__dirname, 'dev-port-runtime.ps1'), 'utf8')
    const launchScript = await readFile(scriptPath, 'utf8')

    expect(runtimeScript).toContain('function Test-PromptCardFrontend')
    expect(runtimeScript).toContain('PromptCard-Agent')
    expect(launchScript).toContain('Test-PromptCardFrontend $runtime.frontendUrl')
    expect(launchScript).not.toContain('Test-HttpOk $runtime.frontendUrl')
  })

  test('neutralizes beforeDevCommand in dynamic Tauri dev config', async () => {
    const script = await readFile(scriptPath, 'utf8')

    expect(script).toContain('$config.build.beforeDevCommand = "cmd /c exit 0"')
  })

  test('supports a services-only mode for storage and agent startup', async () => {
    const script = await readFile(path.resolve(__dirname, 'start-dev-with-agent.ps1'), 'utf8')

    expect(script).toContain('[switch]$ServicesOnly')
    expect(script).toContain('if ($ServicesOnly)')
    expect(script).toContain('PromptCard local services are healthy.')
  })

  test('builds the Windows desktop shell without an extra console window', async () => {
    const rustMain = await readFile(rustMainPath, 'utf8')

    expect(rustMain).toContain('#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]')
  })

  test('keeps the desktop event loop responsive while local services shut down', async () => {
    const rustLib = await readFile(rustLibPath, 'utf8')
    const closeHandler = rustLib.slice(rustLib.indexOf('.on_window_event'), rustLib.indexOf('.run(tauri::generate_context!())'))

    expect(closeHandler).toContain('api.prevent_close()')
    expect(closeHandler).toContain('window.hide()')
    expect(closeHandler).toContain('thread::spawn')
    expect(closeHandler).toContain('SHUTDOWN_STARTED')
    expect(closeHandler.indexOf('thread::spawn')).toBeLessThan(closeHandler.indexOf('shutdown_promptcard_services()'))
  })

  test('bounds shutdown work and cleans every runtime service without slow PowerShell port enumeration', async () => {
    const rustLib = await readFile(rustLibPath, 'utf8')
    const shutdown = rustLib.slice(
      rustLib.indexOf('fn shutdown_promptcard_services'),
      rustLib.indexOf('fn profile_root')
    )

    expect(rustLib).toContain('LOCAL_SERVICE_SHUTDOWN_TIMEOUT')
    expect(rustLib).toContain('try_wait()')
    expect(rustLib).toContain('child.kill()')
    expect(shutdown).toContain('runtime.ports.textAgent')
    expect(shutdown).toContain('runtime.textAgentUrl')
    expect(shutdown).toContain('runtime.textAgentHealthUrl')
    expect(shutdown).toContain('netstat.exe')
    expect(shutdown).not.toContain('Get-NetTCPConnection')
  })

  test('allows the desktop dev shell to follow dynamic local Vite ports', async () => {
    const capability = JSON.parse(await readFile(capabilityPath, 'utf8'))

    expect(capability.remote.urls).toContain('http://127.0.0.1:*')
    expect(capability.remote.urls).toContain('http://localhost:*')
  })
})
