namespace SIDE.Prelude;

/// <summary>
/// 把執行期對回規格來源。見 docs/02-prelude-v0.md。
/// v1 的斷點映射會改用 C# 內建的 #line 指示詞，本 attribute 屆時留作 metadata。
/// </summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public sealed class SemanticSourceAttribute(string srcFile, int line) : Attribute
{
    public string SrcFile { get; } = srcFile;
    public int Line { get; } = line;
}
