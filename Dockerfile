FROM node:20-slim

WORKDIR /app

# 只先拷贝依赖清单（用缓存）
COPY package.json package-lock.json* ./

# 安装生产依赖
RUN npm install --omit=dev

# 再拷贝所有代码
COPY . .

# Cloud Run 会用 PORT 环境变量，不要写死 8080
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# 直接跑你的入口文件，避免 npm start 配置不对
CMD ["node", "index.js"]


