# Minimal Güvenli Tarayıcı

Bu proje Node.js ile yazılmış minimal bir web tarayıcı arayüzüdür.

## Özellikler
- URL ile gezinme (geri/ileri)
- Geçmiş kayıtları (sunucuda saklanır)
- Özel ayarlar:
  - DNS sunucusu seçimi (proxy isteklerinde kullanılır)
  - Güçlü reklam engelleme aç/kapat
- Reklam ve sahte yönlendirme koruması:
  - Bilinen reklam/izleme alan adlarını engeller
  - Şüpheli redirect parametreli linkleri engeller
  - Sayfa içindeki sahte buton tıklamalarını istemci tarafında engeller

## Çalıştırma
```bash
npm start
```

Ardından: `http://localhost:3000`
