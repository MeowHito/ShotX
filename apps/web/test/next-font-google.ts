/**
 * Test stand-in for `next/font/google` (a build-time loader that only runs inside Next): each
 * font function records its options and returns a face named after the family.
 */
export const fontCalls = new Map<string, Record<string, unknown>>();

function loader(exportName: string) {
  const family = exportName.replace(/_/g, ' ');
  return (options: Record<string, unknown> = {}) => {
    fontCalls.set(family, options);
    return {
      className: `font-${exportName.toLowerCase()}`,
      variable: typeof options.variable === 'string' ? options.variable : undefined,
      style: { fontFamily: `'${family}'` },
    };
  };
}

export const Inter = loader('Inter');
export const Noto_Sans_Thai = loader('Noto_Sans_Thai');
export const Kanit = loader('Kanit');
export const Prompt = loader('Prompt');
export const Sarabun = loader('Sarabun');
export const Mitr = loader('Mitr');
export const Chakra_Petch = loader('Chakra_Petch');
export const IBM_Plex_Sans_Thai = loader('IBM_Plex_Sans_Thai');
export const Bai_Jamjuree = loader('Bai_Jamjuree');
export const Noto_Serif_Thai = loader('Noto_Serif_Thai');
export const Playfair_Display = loader('Playfair_Display');
export const Bebas_Neue = loader('Bebas_Neue');
