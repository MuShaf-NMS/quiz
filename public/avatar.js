// Avatar pemain: gambar disajikan server lewat /avatar/<seed>.svg (proxy DiceBear style clay).
const newSeed = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const avatarSrc = (seed) => '/avatar/' + encodeURIComponent(seed || 'x') + '.svg';
const avatar = (seed, cls = '') => `<img class="av ${cls}" src="${avatarSrc(seed)}" alt="">`;
