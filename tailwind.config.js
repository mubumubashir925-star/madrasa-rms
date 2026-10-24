module.exports = {
  content: ['./public/index.html'],
  theme: { extend: {
    fontFamily: { sans: ['Plus Jakarta Sans', 'sans-serif'], serif: ['Amiri', 'serif'] },
    colors: { emerald: Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 850, 900, 950].map(n => [n, `rgb(var(--em-${n}) / <alpha-value>)`])) }
  } }
};
