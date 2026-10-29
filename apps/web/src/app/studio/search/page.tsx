import { SearchView } from '@/components/studio/search-view';
import { parseSearch } from '@/lib/drive/search-params';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function StudioSearchPage({ searchParams }: { searchParams: SearchParams }) {
  const search = parseSearch(await searchParams);
  return <SearchView key={JSON.stringify(search)} search={search} />;
}
