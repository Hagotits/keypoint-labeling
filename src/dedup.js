// 중복 검사용 지문 계산 (브라우저 안에서만 계산, 원본은 업로드 버튼을 누를 때만 전송)
//  - SHA-256: 파일 바이트가 완전히 같은지 (확실한 중복)
//  - dHash(64bit): 크기 변경·재압축된 같은 사진인지 (유사 → 사람이 확인)

const hex = (buf) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256(file) {
  return hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
}

// EXIF 방향을 적용한 뒤(createImageBitmap 기본값) 72x64로 줄이고,
// 8x8 블록 평균으로 9x8 회색조를 만든 다음 가로로 이웃한 칸의 밝기 차이 부호를 비트로 쓴다.
// 큰 사진을 바로 9x8로 줄이면 에일리어싱이 생겨서 두 단계로 줄인다.
export async function fingerprint(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const width = bmp.width
  const height = bmp.height

  const W = 72
  const H = 64
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d', { willReadFrequently: true })
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(bmp, 0, 0, W, H)
  const px = g.getImageData(0, 0, W, H).data

  const gray = new Float64Array(9 * 8)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      gray[Math.floor(y / 8) * 9 + Math.floor(x / 8)] +=
        0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
    }
  }
  let bits = ''
  for (let r = 0; r < 8; r++) {
    for (let k = 0; k < 8; k++) bits += gray[r * 9 + k] > gray[r * 9 + k + 1] ? '1' : '0'
  }
  let dhash = ''
  for (let i = 0; i < 64; i += 4) dhash += parseInt(bits.slice(i, i + 4), 2).toString(16)

  // 목록 표시용 작은 미리보기
  const TW = 240
  const t = document.createElement('canvas')
  t.width = TW
  t.height = Math.max(1, Math.round((TW * height) / width))
  const tg = t.getContext('2d')
  tg.imageSmoothingQuality = 'high'
  tg.drawImage(bmp, 0, 0, t.width, t.height)
  bmp.close()
  const thumb = t.toDataURL('image/jpeg', 0.8)

  return { width, height, dhash, thumb }
}

const POP = Array.from({ length: 16 }, (_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1))
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity
  let d = 0
  for (let i = 0; i < a.length; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)]
  return d
}
