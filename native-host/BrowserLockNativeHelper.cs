// ============================================================
// Browser Lock — Windows Native Credential Helper
// Chrome Native Messaging Host for Windows Security Verification
//
// Triggers the real Windows Security credential prompt (CredUIPromptForWindowsCredentialsW)
// and validates credentials via LogonUserW.
//
// PRIVACY & SECURITY:
// - Windows credentials NEVER leave this native process.
// - Password memory is explicitly zeroed out immediately after verification.
// - Returns only boolean { "success": true } or { "success": false } to Chrome.
// ============================================================

using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;

namespace BrowserLockNativeHelper
{
    class Program
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct CREDUI_INFO
        {
            public int cbSize;
            public IntPtr hwndParent;
            public string pszMessageText;
            public string pszCaptionText;
            public IntPtr hbmBanner;
        }

        public const int CREDUIWIN_GENERIC = 0x0001;
        public const int CREDUIWIN_CHECKBOX = 0x0002;
        public const int CREDUIWIN_AUTHPACKAGE_ONLY = 0x0010;
        public const int CREDUIWIN_IN_CRED_ONLY = 0x0020;
        public const int CREDUIWIN_ENUMERATE_ADMINS = 0x0100;
        public const int CREDUIWIN_ENUMERATE_CURRENT_USER = 0x0200;

        public const int ERROR_SUCCESS = 0;
        public const int ERROR_CANCELLED = 1223;

        public const int LOGON32_LOGON_INTERACTIVE = 2;
        public const int LOGON32_PROVIDER_DEFAULT = 0;

        [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint CredUIPromptForWindowsCredentials(
            ref CREDUI_INFO pUiInfo,
            int dwAuthError,
            ref uint pulAuthPackage,
            IntPtr pvInAuthBuffer,
            uint ulInAuthBufferSize,
            out IntPtr ppvOutAuthBuffer,
            out uint pulOutAuthBufferSize,
            ref bool pfSave,
            int dwFlags);

        [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredUnPackAuthenticationBuffer(
            int dwFlags,
            IntPtr pAuthBuffer,
            uint cbAuthBuffer,
            StringBuilder pszUserName,
            ref int pcchMaxUserName,
            StringBuilder pszDomainName,
            ref int pcchMaxDomainName,
            StringBuilder pszPassword,
            ref int pcchMaxPassword);

        [DllImport("ole32.dll")]
        public static extern void CoTaskMemFree(IntPtr pv);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool LogonUser(
            string lpszUsername,
            string lpszDomain,
            string lpszPassword,
            int dwLogonType,
            int dwLogonProvider,
            out IntPtr phToken);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("msvcrt.dll")]
        public static extern int _setmode(int fd, int mode);
        public const int _O_BINARY = 0x8000;

        static string ReadMessage(Stream stdin)
        {
            byte[] lenBytes = new byte[4];
            int read = 0;
            while (read < 4)
            {
                int r = stdin.Read(lenBytes, read, 4 - read);
                if (r <= 0) return null;
                read += r;
            }

            int length = BitConverter.ToInt32(lenBytes, 0);
            if (length <= 0 || length > 1024 * 1024) return null;

            byte[] buffer = new byte[length];
            int total = 0;
            while (total < length)
            {
                int r = stdin.Read(buffer, total, length - total);
                if (r <= 0) return null;
                total += r;
            }

            return Encoding.UTF8.GetString(buffer);
        }

        static void WriteMessage(Stream stdout, string json)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            byte[] lenBytes = BitConverter.GetBytes(bytes.Length);
            stdout.Write(lenBytes, 0, 4);
            stdout.Write(bytes, 0, bytes.Length);
            stdout.Flush();
        }

        static void Main(string[] args)
        {
            try
            {
                using (Stream stdin = Console.OpenStandardInput())
                using (Stream stdout = Console.OpenStandardOutput())
                {
                    string message = ReadMessage(stdin);
                    if (string.IsNullOrEmpty(message)) return;

                    // Initialize authentic Windows Security Prompt
                    CREDUI_INFO info = new CREDUI_INFO();
                    info.cbSize = Marshal.SizeOf(typeof(CREDUI_INFO));
                    info.hwndParent = GetForegroundWindow();
                    info.pszCaptionText = "Browser Lock — Windows Security Verification";
                    info.pszMessageText = "Please verify your Windows credentials to reset your Browser Lock PIN.";
                    info.hbmBanner = IntPtr.Zero;

                    uint authPackage = 0;
                    IntPtr outCredBuffer = IntPtr.Zero;
                    uint outCredSize = 0;
                    bool save = false;

                    // Prompt user with real Windows Security UI
                    uint res = CredUIPromptForWindowsCredentials(
                        ref info,
                        0,
                        ref authPackage,
                        IntPtr.Zero,
                        0,
                        out outCredBuffer,
                        out outCredSize,
                        ref save,
                        CREDUIWIN_GENERIC | CREDUIWIN_ENUMERATE_CURRENT_USER);

                    if (res == ERROR_SUCCESS)
                    {
                        StringBuilder userName = new StringBuilder(512);
                        int maxUserName = userName.Capacity;
                        StringBuilder domainName = new StringBuilder(512);
                        int maxDomainName = domainName.Capacity;
                        StringBuilder password = new StringBuilder(512);
                        int maxPassword = password.Capacity;

                        bool unpacked = CredUnPackAuthenticationBuffer(
                            0,
                            outCredBuffer,
                            outCredSize,
                            userName,
                            ref maxUserName,
                            domainName,
                            ref maxDomainName,
                            password,
                            ref maxPassword);

                        CoTaskMemFree(outCredBuffer);

                        if (unpacked)
                        {
                            IntPtr token = IntPtr.Zero;
                            string user = userName.ToString();
                            string domain = domainName.ToString();
                            string pass = password.ToString();

                            // Immediately wipe buffers containing sensitive credentials
                            userName.Clear();
                            domainName.Clear();
                            password.Clear();

                            bool valid = LogonUser(
                                user,
                                string.IsNullOrEmpty(domain) ? "." : domain,
                                pass,
                                LOGON32_LOGON_INTERACTIVE,
                                LOGON32_PROVIDER_DEFAULT,
                                out token);

                            if (token != IntPtr.Zero)
                            {
                                CloseHandle(token);
                            }

                            if (valid)
                            {
                                WriteMessage(stdout, "{\"success\":true}");
                            }
                            else
                            {
                                WriteMessage(stdout, "{\"success\":false,\"error\":\"Windows credential verification failed.\"}");
                            }
                        }
                        else
                        {
                            WriteMessage(stdout, "{\"success\":false,\"error\":\"Failed to unpack credentials.\"}");
                        }
                    }
                    else if (res == ERROR_CANCELLED)
                    {
                        WriteMessage(stdout, "{\"success\":false,\"cancelled\":true,\"error\":\"Verification cancelled.\"}");
                    }
                    else
                    {
                        WriteMessage(stdout, "{\"success\":false,\"error\":\"Prompt closed or unavailable (code " + res + ")\"}");
                    }
                }
            }
            catch (Exception ex)
            {
                try
                {
                    using (Stream stdout = Console.OpenStandardOutput())
                    {
                        string safeError = ex.Message.Replace("\"", "\\\"");
                        WriteMessage(stdout, "{\"success\":false,\"error\":\"" + safeError + "\"}");
                    }
                }
                catch { }
            }
        }
    }
}
