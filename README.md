# TINJU 3D

Prototipe Three.js untuk latihan di arena tinju. Proyek ini memakai arena low-poly dan petarung dari folder `public/assets`.

## Jalankan

```bash
npm run dev
```

Buka alamat lokal yang ditampilkan Vite.

## Kontrol

- **WASD**: jalan di dalam ring
- **Ctrl**: jog
- **Shift**: lari
- **Space**: lompat
- **Geser mouse**: putar kamera (klik kiri sekali untuk mengunci kursor; tekan **Esc** untuk melepas)
- **J**: jab
- **K**: cross
- **L**: hook berat

Proyek ini baru berisi arena, karakter, dan gerakan latihan. Belum ada lawan atau sistem hitbox, jadi pukulan belum bisa mengenai target. Gerak jalan, jog, lari, dan lompat memakai animasi Quaternius UAL1; hook memakai Quaternius UAL2. Roll dari UAL1 berupa salto, jadi tidak dipakai. Paket gratis yang terpasang belum menyediakan tendangan atau hindaran tinju yang cocok.

File Blender dan preview arena asli tetap tersedia di folder `boxing-arena/`.
# Tinju3D
