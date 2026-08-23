# Node.js 18 Alpine 공식 이미지 사용
FROM node:18-alpine

# 작업 디렉토리 설정
WORKDIR /app

# 패키지 명세 복사 및 설치
COPY package*.json ./
RUN npm install --production

# 애플리케이션 소스 코드 전체 복사
COPY . .

# GCP 컨테이너 환경 포트 노출
EXPOSE 3000

# 서버 실행
CMD ["npm", "start"]