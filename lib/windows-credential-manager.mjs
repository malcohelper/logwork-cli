import { spawn } from 'node:child_process';

export const WINDOWS_CREDENTIAL_PERSIST_LOCAL_MACHINE = 2;

export function createWindowsCredentialTokenStorage({
  service = 'logwork-helper',
  account = 'resourceoptimiser',
  run = runPowerShellCredentialCommand
} = {}) {
  return createWindowsCredentialValueStorage({ service, account, run });
}

export function createWindowsCredentialEmailStorage({
  service = 'logwork-helper',
  account = 'resourceoptimiser-email',
  run = runPowerShellCredentialCommand
} = {}) {
  return createWindowsCredentialValueStorage({ service, account, run });
}

export function createWindowsCredentialValueStorage({
  service = 'logwork-helper',
  account = 'resourceoptimiser',
  run = runPowerShellCredentialCommand
} = {}) {
  const target = windowsCredentialTarget(service, account);

  return {
    async get() {
      const result = await run({
        action: 'get',
        target,
        username: account
      });
      return result?.found ? String(result.value || '') : null;
    },

    async set(value) {
      await run({
        action: 'set',
        target,
        username: account,
        value
      });
    },

    async delete() {
      const result = await run({
        action: 'delete',
        target,
        username: account
      });
      return Boolean(result?.deleted);
    }
  };
}

export function windowsCredentialTarget(service, account) {
  return `${service}:${account}`;
}

export function runPowerShellCredentialCommand(request, {
  command = 'powershell.exe',
  spawnFn = spawn
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_CREDENTIAL_SCRIPT
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Windows Credential Manager command failed with exit code ${code}: ${stderr.trim() || 'no stderr'}`));
        return;
      }

      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : {});
      } catch (error) {
        reject(new Error(`Windows Credential Manager command returned invalid JSON: ${error.message}`));
      }
    });

    child.stdin.end(JSON.stringify(request));
  });
}

const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class LogworkCredentialManager
{
    private const UInt32 CRED_TYPE_GENERIC = 1;
    private const UInt32 CRED_PERSIST_LOCAL_MACHINE = 2;
    private const Int32 ERROR_NOT_FOUND = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL
    {
        public UInt32 Flags;
        public UInt32 Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredRead(string target, UInt32 type, UInt32 reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr credentialPtr);

    public static void Write(string target, string userName, string secret)
    {
        byte[] secretBytes = Encoding.Unicode.GetBytes(secret ?? "");
        if (secretBytes.Length > 5120)
        {
            throw new InvalidOperationException("Credential value is too large for Windows Credential Manager.");
        }

        IntPtr secretPtr = Marshal.AllocCoTaskMem(secretBytes.Length);
        try
        {
            Marshal.Copy(secretBytes, 0, secretPtr, secretBytes.Length);
            CREDENTIAL credential = new CREDENTIAL();
            credential.Type = CRED_TYPE_GENERIC;
            credential.TargetName = target;
            credential.UserName = userName;
            credential.CredentialBlob = secretPtr;
            credential.CredentialBlobSize = (UInt32)secretBytes.Length;
            credential.Persist = CRED_PERSIST_LOCAL_MACHINE;

            if (!CredWrite(ref credential, 0))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            Marshal.FreeCoTaskMem(secretPtr);
        }
    }

    public static string Read(string target)
    {
        IntPtr credentialPtr;
        if (!CredRead(target, CRED_TYPE_GENERIC, 0, out credentialPtr))
        {
            int error = Marshal.GetLastWin32Error();
            if (error == ERROR_NOT_FOUND)
            {
                return null;
            }
            throw new Win32Exception(error);
        }

        try
        {
            CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(credentialPtr, typeof(CREDENTIAL));
            if (credential.CredentialBlobSize == 0)
            {
                return "";
            }

            byte[] secretBytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, secretBytes, 0, secretBytes.Length);
            return Encoding.Unicode.GetString(secretBytes);
        }
        finally
        {
            CredFree(credentialPtr);
        }
    }

    public static bool Delete(string target)
    {
        if (CredDelete(target, CRED_TYPE_GENERIC, 0))
        {
            return true;
        }

        int error = Marshal.GetLastWin32Error();
        if (error == ERROR_NOT_FOUND)
        {
            return false;
        }
        throw new Win32Exception(error);
    }
}
'@

$inputJson = [Console]::In.ReadToEnd()
$request = $inputJson | ConvertFrom-Json

switch ($request.action) {
  'get' {
    $value = [LogworkCredentialManager]::Read([string]$request.target)
    if ($null -eq $value) {
      @{ ok = $true; found = $false } | ConvertTo-Json -Compress
    } else {
      @{ ok = $true; found = $true; value = $value } | ConvertTo-Json -Compress
    }
    break
  }
  'set' {
    [LogworkCredentialManager]::Write([string]$request.target, [string]$request.username, [string]$request.value)
    @{ ok = $true } | ConvertTo-Json -Compress
    break
  }
  'delete' {
    $deleted = [LogworkCredentialManager]::Delete([string]$request.target)
    @{ ok = $true; deleted = $deleted } | ConvertTo-Json -Compress
    break
  }
  default {
    throw "Unknown credential action: $($request.action)"
  }
}
`;
