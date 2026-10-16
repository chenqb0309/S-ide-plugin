using SemanticBackend;
using SIDE.Prelude;

// 入口是手寫的，不交給 AI。Generated/ 底下的東西才是可拋棄的。
Console.OutputEncoding = System.Text.Encoding.UTF8;

var 規格 = new 箱規格 { 重量 = 18m, 長 = 400, 寬 = 300, 高 = 250 };
var 堆疊器 = new 棧板堆疊器();

Telemetry.Step("示範開始");

var 單層箱數 = 堆疊器.計算單層箱數(規格);
var 可堆疊層數 = 堆疊器.計算可堆疊層數(規格, 1800);

Console.WriteLine($"單層箱數   = {單層箱數}");
Console.WriteLine($"可堆疊層數 = {可堆疊層數}");
