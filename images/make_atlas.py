import os
from PIL import Image

files = {
    "idle": "work/basic.png",
    "run":  "work/run.png",
    "jump": "work/jump.png",
    "dead": "work/dead.png"
}

# 1024x1024 투명 캔버스 생성
atlas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))

# 2x2 셀 위치 매핑 (좌상: idle, 우상: run, 좌하: jump, 우하: dead)
positions = {
    "idle": (0, 0),
    "run":  (512, 0),
    "jump": (0, 512),
    "dead": (512, 512)
}

print("=" * 45)
print("🎨 원본 유지 표정 아틀라스 생성 시작")
print("=" * 45)

extracted_skin_color = None

for key, path in files.items():
    if os.path.exists(path):
        # 원본 이미지 로드 및 512x512 리사이징 (대칭 왜곡 없이 원본 비율 유지)
        img = Image.open(path).convert("RGBA")
        img = img.resize((512, 512), Image.Resampling.LANCZOS)
        
        # 기본 표정(idle)의 뺨 부근 픽셀(x:256, y:380)에서 피부색 자동 추출
        if key == "idle":
            r, g, b, a = img.getpixel((256, 380))
            extracted_skin_color = f"0x{r:02x}{g:02x}{b:02x}"
        
        # 아틀라스 위치에 원본 그대로 배치
        atlas.paste(img, positions[key], img)
        print(f"✅ {key} 표정 원본 배치 완료")
    else:
        print(f"⚠️ {path} 파일이 없어 해당 영역을 건너뜁니다.")

# 최종 아틀라스 저장
atlas.save("face_atlas.png")

print("=" * 45)
print("🎉 face_atlas.png 생성 완료!")
if extracted_skin_color:
    print(f"📌 추출된 피부색 값: {extracted_skin_color}")
    print(f"👉 index.html 상단의 const SKIN_COLOR = {extracted_skin_color}; 로 적용하세요.")
print("=" * 45)