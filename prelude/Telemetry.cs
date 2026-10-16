using System.Diagnostics;

namespace SIDE.Prelude;

/// <summary>
/// 業務時序鏈的資料來源。見 docs/02-prelude-v0.md。
/// 這不是裝飾，是承重結構——當語法不可見時，這是人類唯一能看到行為的通道。
/// </summary>
public static class Telemetry
{
    private static readonly object Gate = new();

    public static void Step(string message)
    {
        var frame = new StackTrace().GetFrame(1)?.GetMethod();
        var where = frame is null ? "?" : $"{frame.DeclaringType?.Name}.{frame.Name}";

        lock (Gate)
        {
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {where} → {message}");
        }
    }
}
