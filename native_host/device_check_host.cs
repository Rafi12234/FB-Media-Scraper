using System;
using System.Collections.Generic;
using System.IO;
using System.Net.NetworkInformation;
using System.Text;

public class DeviceCheckHost
{
    public static void Main(string[] args)
    {
        try
        {
            string message = ReadMessage();
            if (message == null)
            {
                return;
            }

            if (message.IndexOf("GET_MACS", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                SendMessage(BuildMacResponseJson());
                return;
            }

            SendMessage("{\"ok\":false,\"error\":\"Unknown command\"}");
        }
        catch (Exception ex)
        {
            SendMessage("{\"ok\":false,\"error\":\"" + EscapeJson(ex.Message) + "\"}");
        }
    }

    private static string ReadMessage()
    {
        Stream input = Console.OpenStandardInput();
        byte[] lengthBytes = new byte[4];
        int bytesRead = input.Read(lengthBytes, 0, 4);
        if (bytesRead == 0)
        {
            return null;
        }
        if (bytesRead < 4)
        {
            throw new Exception("Invalid message length header");
        }

        int length = BitConverter.ToInt32(lengthBytes, 0);
        if (length <= 0 || length > 1024 * 1024)
        {
            throw new Exception("Invalid message length");
        }

        byte[] buffer = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            int read = input.Read(buffer, offset, length - offset);
            if (read <= 0)
            {
                break;
            }
            offset += read;
        }

        return Encoding.UTF8.GetString(buffer, 0, offset);
    }

    private static void SendMessage(string json)
    {
        byte[] messageBytes = Encoding.UTF8.GetBytes(json);
        byte[] lengthBytes = BitConverter.GetBytes(messageBytes.Length);
        Stream output = Console.OpenStandardOutput();
        output.Write(lengthBytes, 0, lengthBytes.Length);
        output.Write(messageBytes, 0, messageBytes.Length);
        output.Flush();
    }

    private static string BuildMacResponseJson()
    {
        List<string> macs = GetMacAddresses();
        StringBuilder builder = new StringBuilder();
        builder.Append("{\"ok\":true,\"macs\":[");
        for (int i = 0; i < macs.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(",");
            }
            builder.Append("\"").Append(EscapeJson(macs[i])).Append("\"");
        }
        builder.Append("]}");
        return builder.ToString();
    }

    private static List<string> GetMacAddresses()
    {
        List<string> macs = new List<string>();

        foreach (NetworkInterface networkInterface in NetworkInterface.GetAllNetworkInterfaces())
        {
            PhysicalAddress address = networkInterface.GetPhysicalAddress();
            if (address == null)
            {
                continue;
            }

            byte[] bytes = address.GetAddressBytes();
            if (bytes == null || bytes.Length != 6)
            {
                continue;
            }

            string mac = BitConverter.ToString(bytes).Replace("-", ":").ToUpperInvariant();
            if (!String.IsNullOrWhiteSpace(mac) && !macs.Contains(mac))
            {
                macs.Add(mac);
            }
        }

        return macs;
    }

    private static string EscapeJson(string value)
    {
        if (value == null)
        {
            return "";
        }

        return value
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"")
            .Replace("\r", "\\r")
            .Replace("\n", "\\n");
    }
}
