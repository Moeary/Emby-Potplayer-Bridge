using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

internal static class Program
{
    private const string PlayerFileName = "PotPlayerMini64.exe";
    private const int MaxMessageBytes = 16 * 1024 * 1024;
    private const int MaxPlaylistItems = 4096;
    private static readonly string[] DefaultAllowedOrigins =
    {
        "https://emby.moear.de",
        "https://jellyfin.moear.de",
    };
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private static void Main()
    {
        using var input = Console.OpenStandardInput();
        using var output = Console.OpenStandardOutput();

        while (TryReadMessage(input, out var json))
        {
            BridgeResponse response;
            try
            {
                var request = JsonSerializer.Deserialize<BridgeRequest>(json, JsonOptions)
                    ?? throw new InvalidOperationException("空的 Native Messaging 请求");
                response = Handle(request);
            }
            catch (Exception error)
            {
                WriteError(error);
                response = new BridgeResponse(false, 0, error.Message);
            }

            WriteMessage(output, JsonSerializer.SerializeToUtf8Bytes(response, JsonOptions));
        }
    }

    private static BridgeResponse Handle(BridgeRequest request)
    {
        if (!string.Equals(request.Type, "play", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("未知的桥接请求类型");
        var playerPath = ResolvePlayerPath();
        if (!File.Exists(playerPath))
            throw new FileNotFoundException("找不到 PotPlayer；请把 PotPlayerBridgeHost.exe 放在 PotPlayerMini64.exe 旁边，或设置 POTPLAYER_PATH", playerPath);

        var entries = ValidateEntries(request.Items, request.AllowedOrigins);
        if (entries.Count == 0) throw new InvalidOperationException("没有可播放的视频地址");
        CleanupOldPlaylists();
        var playlistPath = WritePlaylist(entries);
        StartPotPlayer(playlistPath, playerPath);
        return new BridgeResponse(true, entries.Count, null);
    }

    private static List<PlaylistEntry> ValidateEntries(List<PlaylistEntry>? rawEntries, List<string>? allowedOrigins)
    {
        var entries = new List<PlaylistEntry>();
        foreach (var entry in rawEntries ?? new List<PlaylistEntry>())
        {
            if (string.IsNullOrWhiteSpace(entry.Url) || !Uri.TryCreate(entry.Url, UriKind.Absolute, out var parsed)) continue;
            if (!IsAllowedOrigin(parsed, allowedOrigins)) continue;
            var title = (entry.Title ?? string.Empty).Replace('\r', ' ').Replace('\n', ' ').Trim();
            if (title.Length == 0) title = parsed.Segments.LastOrDefault()?.Trim('/') ?? "Emby/Jellyfin video";
            entries.Add(new PlaylistEntry(entry.Url, title));
            if (entries.Count > MaxPlaylistItems)
                throw new InvalidOperationException($"播放列表项目超过 {MaxPlaylistItems} 项");
        }
        return entries;
    }

    private static bool IsAllowedOrigin(Uri parsed, List<string>? allowedOrigins)
    {
        if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) return false;
        var requestedOrigins = allowedOrigins ?? new List<string>();
        foreach (var rawOrigin in requestedOrigins.Concat(DefaultAllowedOrigins).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!Uri.TryCreate(rawOrigin, UriKind.Absolute, out var allowed)) continue;
            if (allowed.Scheme != Uri.UriSchemeHttp && allowed.Scheme != Uri.UriSchemeHttps) continue;
            if (!string.Equals(parsed.Scheme, allowed.Scheme, StringComparison.OrdinalIgnoreCase)) continue;
            if (!string.Equals(parsed.Host, allowed.Host, StringComparison.OrdinalIgnoreCase)) continue;
            if (parsed.Port != allowed.Port) continue;
            return true;
        }
        return false;
    }

    private static string WritePlaylist(List<PlaylistEntry> entries)
    {
        var directory = Path.Combine(Path.GetTempPath(), "PotPlayerPlaylists");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"emby-jellyfin-{Guid.NewGuid():N}.m3u8");
        var content = new StringBuilder("#EXTM3U\r\n");
        foreach (var entry in entries)
        {
            content.Append("#EXTINF:-1,").Append(entry.Title).Append("\r\n");
            content.Append(entry.Url).Append("\r\n");
        }
        File.WriteAllText(path, content.ToString(), new UTF8Encoding(false));
        return path;
    }

    private static string ResolvePlayerPath()
    {
        var configuredPath = Environment.GetEnvironmentVariable("POTPLAYER_PATH");
        if (!string.IsNullOrWhiteSpace(configuredPath)) return configuredPath.Trim().Trim('"');
        return Path.Combine(AppContext.BaseDirectory, PlayerFileName);
    }

    private static void StartPotPlayer(string playlistPath, string playerPath)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = playerPath,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add("/current");
        startInfo.ArgumentList.Add(playlistPath);
        Process.Start(startInfo)?.Dispose();
    }

    private static void CleanupOldPlaylists()
    {
        try
        {
            var directory = Path.Combine(Path.GetTempPath(), "PotPlayerPlaylists");
            if (!Directory.Exists(directory)) return;
            var threshold = DateTime.Now.AddMinutes(-10);
            foreach (var file in Directory.EnumerateFiles(directory, "emby-jellyfin-*.m3u8"))
            {
                if (File.GetLastWriteTime(file) < threshold) File.Delete(file);
            }
        }
        catch
        {
            // 清理失败不应阻止当前播放。
        }
    }

    private static bool TryReadMessage(Stream input, out byte[] message)
    {
        message = Array.Empty<byte>();
        var lengthBytes = new byte[4];
        if (!ReadExact(input, lengthBytes)) return false;
        var length = BinaryPrimitives.ReadInt32LittleEndian(lengthBytes);
        if (length <= 0 || length > MaxMessageBytes) throw new InvalidOperationException("Native Messaging 消息长度无效");
        message = new byte[length];
        if (!ReadExact(input, message)) throw new EndOfStreamException("Native Messaging 消息不完整");
        return true;
    }

    private static bool ReadExact(Stream stream, byte[] buffer)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = stream.Read(buffer, offset, buffer.Length - offset);
            if (read == 0) return false;
            offset += read;
        }
        return true;
    }

    private static void WriteMessage(Stream output, byte[] message)
    {
        var length = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(length, message.Length);
        output.Write(length, 0, length.Length);
        output.Write(message, 0, message.Length);
        output.Flush();
    }

    private static void WriteError(Exception error)
    {
        try
        {
            var directory = Path.Combine(Path.GetTempPath(), "PotPlayerPlaylists");
            Directory.CreateDirectory(directory);
            File.AppendAllText(Path.Combine(directory, "native-host-error.txt"), $"{DateTime.Now:O}\r\n{error.Message}\r\n", Encoding.UTF8);
        }
        catch
        {
            // 日志失败不应污染 Native Messaging stdout。
        }
    }

    private sealed record BridgeRequest(string? Type, string? Mode, List<PlaylistEntry>? Items, List<string>? AllowedOrigins);
    private sealed record PlaylistEntry(string? Url, string? Title);
    private sealed record BridgeResponse(bool Ok, int Count, string? Error);
}
