param([switch]$Sondar,[int]$TimeoutMs=3000)
$TimeoutMs=[Math]::Max(500,[Math]::Min(5000,$TimeoutMs))
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public class HubUsb {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr sec,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern bool CancelIoEx(SafeFileHandle h,IntPtr ov);
  static int Read(FileStream f,SafeFileHandle h,byte[] b,int timeout) {
    var r=f.ReadAsync(b,0,b.Length);
    if(!r.Wait(timeout)){CancelIoEx(h,IntPtr.Zero);try{r.Wait(1000);}catch{};return 0;}
    return r.Result;
  }
  public static string Query(string path,int timeout) {
    using(var h=CreateFile(path,0xC0000000,3,IntPtr.Zero,3,0x40000000,IntPtr.Zero)) {
      if(h.IsInvalid)throw new Exception("CreateFile USB: "+Marshal.GetLastWin32Error());
      using(var f=new FileStream(h,FileAccess.ReadWrite,4096,true)) {
        // Consumir resposta antiga antes da consulta atual; USB pode fragmentar os quadros.
        byte[] stale=new byte[4096];for(int i=0;i<8;i++){if(Read(f,h,stale,100)==0)break;}
        byte[] b=Encoding.ASCII.GetBytes("~HI");var w=f.WriteAsync(b,0,b.Length);
        if(!w.Wait(timeout)){CancelIoEx(h,IntPtr.Zero);throw new Exception("Escrita USB incerta por timeout; não repetir impressão");}
        f.Flush();
        byte[] output=new byte[4096];var result=new StringBuilder();int frames=0,expected=1;
        var until=DateTime.UtcNow.AddMilliseconds(timeout);
        while(DateTime.UtcNow<until && frames<expected){int n=Read(f,h,output,500);if(n==0)continue;result.Append(Encoding.ASCII.GetString(output,0,n));for(int i=0;i<n;i++)if(output[i]==3)frames++;}
        return result.ToString();
      }
    }
  }
}
'@
$printers=@(Get-Printer)
$usb=@()
. {
  # A fila USB001 antiga não prova presença. Vincular porta -> USBPRINT presente -> pai USB.
  foreach($dev in @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object {$_.InstanceId -like 'USBPRINT\*'})){
    try{
      $reg='HKLM:\SYSTEM\CurrentControlSet\Enum\'+$dev.InstanceId+'\Device Parameters'
      $port=(Get-ItemProperty -LiteralPath $reg -ErrorAction Stop).PortName
      $parent=(Get-PnpDeviceProperty -InstanceId $dev.InstanceId -KeyName 'DEVPKEY_Device_Parent' -ErrorAction Stop).Data
      if($parent -like 'USB\VID_0A5F*' -and $port){
        $present=Get-PnpDevice -InstanceId $parent -PresentOnly -ErrorAction Stop
        if($present.Status -eq 'OK'){$usb+=@{port=$port;parent=$parent}}
      }
    }catch{}
  }
}
$out=@()
foreach($p in $printers){
  $o=[ordered]@{v=1;driver=$p.DriverName;port=$p.PortName;device='';method='unknown';response='';observed_at=[DateTime]::UtcNow.ToString('o')}
  try{
    $matches=@($usb|Where-Object {$_.port -eq $p.PortName})
    if($matches.Count -eq 1){$o.device=$matches[0].parent}
    if($Sondar -and $matches.Count -eq 1 -and @($printers|Where-Object {$_.PortName -eq $p.PortName -and $_.JobCount -gt 0}).Count -eq 0){
      $inst=$matches[0].parent;$o.device=$inst
      $keys=@(Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceClasses\{28d78fad-5a12-11d1-ae5b-0000f803a8c2}'|Where-Object {(Get-ItemProperty $_.PSPath).DeviceInstance -eq $inst})
      if($keys.Count -eq 1){
        $path='\\?\'+$keys[0].PSChildName.Substring(4)
        $o.response=[HubUsb]::Query($path,$TimeoutMs);$o.method='usb_hi'
      }
    }
  }catch{$o.method='unknown';$o.response=''}
  $out += [pscustomobject]@{Name=$p.Name;DriverName=$p.DriverName;PortName=$p.PortName;capabilities=[pscustomobject]$o}
}
ConvertTo-Json -InputObject $out -Depth 4 -Compress
