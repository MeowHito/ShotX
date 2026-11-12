import { DESIGN_FONT_INFO, DESIGN_THAI_FALLBACK_FONT, type DesignFont } from '@shotx/shared';
import {
  Bai_Jamjuree,
  Bebas_Neue,
  Chakra_Petch,
  IBM_Plex_Sans_Thai,
  Kanit,
  Mitr,
  Noto_Sans_Thai,
  Noto_Serif_Thai,
  Playfair_Display,
  Prompt,
  Sarabun,
} from 'next/font/google';

/*
 * The design fonts (ADR 0013, DESIGN_FONTS), self-hosted with next/font: downloaded at build time
 * and served from /_next/static (CSP font-src 'self'), never a font CDN at run time. Weights and
 * italics are those of DESIGN_FONT_INFO (next/font needs literals; fonts.test checks they match).
 * `preload: false`: a page only downloads the faces its design actually uses, when it uses them.
 */

const noto = Noto_Sans_Thai({
  weight: ['300', '400', '500', '600', '700', '800', '900'],
  subsets: ['thai', 'latin'],
  display: 'swap',
  preload: false,
});
const kanit = Kanit({
  weight: ['300', '400', '500', '600', '700', '800', '900'],
  style: ['normal', 'italic'],
  subsets: ['thai', 'latin'],
  display: 'swap',
  preload: false,
});
const prompt = Prompt({
  weight: ['300', '400', '500', '600', '700', '800', '900'],
  style: ['normal', 'italic'],
  subsets: ['thai', 'latin'],
  display: 'swap',
  preload: false,
});
const sarabun = Sarabun({
  weight: ['300', '400', '500', '600', '700', '800'],
  style: ['normal', 'italic'],
  subsets: ['thai', 'latin'],
  display: 'swap',
  preload: false,
});
const mitr = Mitr({
  weight: ['300', '400', '500', '600', '700'],
  subsets: ['thai', 'latin'],
  display: 'swap',
  preload: false,
});
const chakraPetch = Chakra_Petch({
  weight: ['300', '400', '500', '600', '700'],
  style: ['normal', 'italic'],
  subsets: ['thai', 'latin'],
  display: 'swap',
  preload: false,
});
const ibmPlexSansThai = IBM_Plex_Sans_Thai({
  weight: ['300', '400', '500', '600', '700'],
  subsets: ['thai', 'latin'],
  display: 'swap',
  preload: false,
});
const baiJamjuree = Bai_Jamjuree({
  weight: ['300', '400', '500', '600', '700'],
  style: ['normal', 'italic'],
  subsets: ['thai', 'latin'],
  display: 'swap',
  preload: false,
});
const notoSerifThai = Noto_Serif_Thai({
  weight: ['300', '400', '500', '600', '700', '800', '900'],
  subsets: ['thai', 'latin'],
  display: 'swap',
  preload: false,
});
const playfairDisplay = Playfair_Display({
  weight: ['400', '500', '600', '700', '800', '900'],
  style: ['normal', 'italic'],
  subsets: ['latin'],
  display: 'swap',
  preload: false,
});
const bebasNeue = Bebas_Neue({
  weight: ['400'],
  subsets: ['latin'],
  display: 'swap',
  preload: false,
});

/** The loaded face of each design font. */
export const DESIGN_FONT_FACES: Record<DesignFont, { style: { fontFamily: string } }> = {
  'noto-sans-thai': noto,
  kanit,
  prompt,
  sarabun,
  mitr,
  'chakra-petch': chakraPetch,
  'ibm-plex-sans-thai': ibmPlexSansThai,
  'bai-jamjuree': baiJamjuree,
  'noto-serif-thai': notoSerifThai,
  'playfair-display': playfairDisplay,
  'bebas-neue': bebasNeue,
};

/**
 * The CSS font-family of a design font: its self-hosted face, then (for the Latin-only faces)
 * Noto Sans Thai for Thai characters, then the system sans-serif.
 */
export function designFontFamily(font: DesignFont): string {
  const own = DESIGN_FONT_FACES[font].style.fontFamily;
  const thai = DESIGN_FONT_INFO[font].thai
    ? []
    : [DESIGN_FONT_FACES[DESIGN_THAI_FALLBACK_FONT].style.fontFamily];
  return [own, ...thai, 'sans-serif'].join(', ');
}

/** The display name of a font (its family name, the same in every language). */
export function designFontLabel(font: DesignFont): string {
  return DESIGN_FONT_INFO[font].family;
}
