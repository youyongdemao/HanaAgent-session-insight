// Session Insight 宿主端入口（manifestVersion 2 的 entry 指向这里）
// 具体实现分别在 routes/api.js（数据接口）与 routes/ui.js（页面与 widget 路由），
// 这里聚合出一个统一入口，供宿主加载。
import registerApiRoutes from "./routes/api.js";
import registerUiRoutes from "./routes/ui.js";

// 路由注册函数列表：签名 (app, ctx) => void，与两个模块的默认导出一致
export const pluginRoutes = [registerApiRoutes, registerUiRoutes];

export default function activate() {
  return { pluginRoutes };
}
