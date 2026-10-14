if (!process.env.TYPESAFE_API_KEY) {
  console.error("请先在服务端环境变量中设置 TYPESAFE_API_KEY，再运行 npm run dev。");
  process.exit(1);
}
await import("./local-dev.mjs");
