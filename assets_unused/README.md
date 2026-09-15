# 쓰지 않는 에셋 보관소

배포에서 빼기 위해 `public/assets/` 에서 옮겨 둔 파일들입니다.
`public/` 밖이라 서버가 서빙하지 않습니다.

| 파일 | 크기 | 왜 안 쓰는가 |
|---|---|---|
| `character_prev.glb` | 30.5 MB | 코드 어디서도 참조하지 않습니다 |
| `character_san.glb` | 1.6 MB | 코드 어디서도 참조하지 않습니다 |
| `face_atlas.png` | 0.7 MB | 얼굴이 절차적으로 그려지도록 바뀐 뒤 참조가 사라졌습니다 |

합계 약 **32.8 MB** 로, 배포 크기의 대부분이었습니다.

되살리려면 `public/assets/` 로 되돌리고, 참조를 붙인 다음
`index.html` 의 `ASSET_VER` 를 올리세요.

저장소에서 아예 지우려면 `git rm -r assets_unused` — 다만 지운 뒤에도
git 히스토리에는 남으므로 클론 크기는 줄지 않습니다.
