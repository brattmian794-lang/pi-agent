/** Windows Job Object 监督器：先挂起创建子进程，纳入 Job 后才恢复，避免子进程逃逸竞态。 */
export const WINDOWS_BACKGROUND_RUNNER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class PromaBackgroundJob {
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public uint cb; public string reserved; public string desktop; public string title;
    public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public short show, reservedSize; public IntPtr reservedData,stdin,stdout,stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long processTime,jobTime; public uint flags;
    public UIntPtr minWork,maxWork; public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
    public long userTime,kernelTime,periodUser,periodKernel; public uint faults,total,active,terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref EXTENDED_LIMIT info,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out ACCOUNTING info,uint size,IntPtr returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr attrs,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static int Run(string app,string command,string cwd,string marker) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null);
    if (job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    PROCESS_INFORMATION pi=new PROCESS_INFORMATION();
    IntPtr emptyInput=CreateFile("NUL",0x80000000,3,IntPtr.Zero,3,0x80,IntPtr.Zero);
    if (emptyInput==new IntPtr(-1)) { CloseHandle(job); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    try {
      EXTENDED_LIMIT limits=new EXTENDED_LIMIT(); limits.basic.flags=0x2000;
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits)));
      STARTUPINFO si=new STARTUPINFO(); si.cb=(uint)Marshal.SizeOf(si); si.flags=0x100;
      Check(SetHandleInformation(emptyInput,1,1));
      si.stdin=emptyInput; si.stdout=GetStdHandle(-11); si.stderr=GetStdHandle(-12);
      Check(CreateProcess(app,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref si,out pi));
      // 从未恢复的进程若分配失败也必须终止，不能留下不可见的挂起进程。
      if (!AssignProcessToJobObject(job,pi.process)) {
        int error=Marshal.GetLastWin32Error(); TerminateProcess(pi.process,1); throw new Win32Exception(error);
      }
      Console.Error.WriteLine(marker+":"+pi.pid); Console.Error.Flush();
      if (ResumeThread(pi.thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
      var control=new Thread(()=>{
        try {
          // 控制管道仅由监督器读取，用户进程使用 NUL 输入。
          string line=Console.ReadLine();
          if (line==null || line=="stop") TerminateJobObject(job,143);
        } catch { TerminateJobObject(job,143); }
      });
      control.IsBackground=true; control.Start();
      while (true) {
        ACCOUNTING info;
        Check(QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero));
        if (info.active==0) break;
        Thread.Sleep(50);
      }
      uint code; Check(GetExitCodeProcess(pi.process,out code)); return unchecked((int)code);
    } finally {
      // KILL_ON_JOB_CLOSE 保证监督器异常退出时也清理整棵受管进程树。
      CloseHandle(job);
      CloseHandle(emptyInput);
      if (pi.thread!=IntPtr.Zero) CloseHandle(pi.thread);
      if (pi.process!=IntPtr.Zero) CloseHandle(pi.process);
    }
  }
}
'@
$executable = [Environment]::GetEnvironmentVariable('PROMA_BG_EXECUTABLE')
$arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PROMA_BG_ARGUMENTS))
exit ([PromaBackgroundJob]::Run($executable, $arguments, $env:PROMA_BG_CWD, $env:PROMA_BG_MARKER))
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
`
