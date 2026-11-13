# Prints the title of the native dialog the app has open, then closes it without choosing anything.
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 scripts without a BOM.
param([int]$AppPid, [int]$TimeoutMs = 8000)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DialogTitle {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, _) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      var cls = new StringBuilder(64);
      GetClassName(h, cls, 64);
      if (owner == pid && IsWindowVisible(h) && cls.ToString() == "#32770") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static string Title(IntPtr h) {
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    return sb.ToString();
  }

  public static void Close(IntPtr h) { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
"@

$end = [DateTime]::Now.AddMilliseconds($TimeoutMs)
while ([DateTime]::Now -lt $end) {
  $h = [DialogTitle]::Find([uint32]$AppPid)
  if ($h -ne [IntPtr]::Zero) {
    # The title is printed as UTF-16 code units so the caller doesn't depend on the console code page
    $title = [DialogTitle]::Title($h)
    [DialogTitle]::Close($h)
    [Console]::Out.Write((($title.ToCharArray() | ForEach-Object { [int]$_ }) -join ","))
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
exit 3
