/** @type {import('next').NextConfig} */
const nextConfig = {
  // `output: 'standalone'` retiré : sur Render avec `next start`, cette option
  // génère un bundle dans .next/standalone/ que next start ne sait PAS servir →
  // warning Next + risque de servir un build périmé. Sans standalone, Render
  // sert correctement depuis .next/server/ comme prévu par next start.
};

export default nextConfig;
