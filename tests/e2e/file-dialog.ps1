# Answers a native file dialog opened by the app: fills in the paths and confirms.
# Uses Win32 messages, so it does not depend on keyboard focus.
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 scripts without a BOM.
param(
  [int]$AppPid,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths
)

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class FileDialog {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

  const uint WM_SETTEXT = 0x000C, BM_CLICK = 0x00F5, TDM_CLICK_BUTTON = 0x0400 + 102;
  const int IDOK = 1, IDYES = 6;

  static string ClassOf(IntPtr h) {
    var sb = new StringBuilder(64);
    GetClassName(h, sb, 64);
    return sb.ToString();
  }

  public static List<IntPtr> Dialogs(uint pid) {
    var found = new List<IntPtr>();
    EnumWindows((h, _) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner == pid && IsWindowVisible(h) && ClassOf(h) == "#32770") found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static IntPtr FileNameEdit(IntPtr dialog) {
    IntPtr edit = IntPtr.Zero;
    EnumChildWindows(dialog, (h, _) => {
      if (ClassOf(h) == "Edit" && ClassOf(GetParent(h)) == "ComboBox") { edit = h; return false; }
      return true;
    }, IntPtr.Zero);
    return edit;
  }

  public static bool Answer(IntPtr dialog, string text) {
    IntPtr edit = FileNameEdit(dialog);
    IntPtr ok = GetDlgItem(dialog, IDOK);
    if (edit == IntPtr.Zero || ok == IntPtr.Zero) return false;
    SendMessage(edit, WM_SETTEXT, IntPtr.Zero, text);
    PostMessage(ok, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    return true;
  }

  // Accepts the "file already exists, replace it?" prompt
  public static void ConfirmReplace(IntPtr dialog) {
    SendMessage(dialog, TDM_CLICK_BUTTON, new IntPtr(IDYES), IntPtr.Zero);
  }
}
"@

$deadline = (Get-Date).AddSeconds(15)
$dialog = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and $dialog -eq [IntPtr]::Zero) {
  $dialogs = [FileDialog]::Dialogs($AppPid)
  if ($dialogs.Count -gt 0) { $dialog = $dialogs[0] } else { Start-Sleep -Milliseconds 100 }
}
if ($dialog -eq [IntPtr]::Zero) { throw "No file dialog appeared" }
Start-Sleep -Milliseconds 400

if ($Paths.Count -eq 1) {
  $text = $Paths[0]
} else {
  $text = ($Paths | ForEach-Object { [char]34 + $_ + [char]34 }) -join " "
}
if (-not [FileDialog]::Answer($dialog, $text)) { throw "File name box or OK button not found" }

# Done once the dialog closes. Saving over an existing file adds a replace prompt.
$deadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 200
  $open = [FileDialog]::Dialogs($AppPid)
  if ($open.Count -eq 0) { exit 0 }
  foreach ($d in $open) { if ($d -ne $dialog) { [FileDialog]::ConfirmReplace($d) } }
}
throw "File dialog did not close"
