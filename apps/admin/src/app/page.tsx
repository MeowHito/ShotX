import { redirect } from 'next/navigation';

/** The users page is the admin app's first (and for now only) page. */
export default function Home() {
  redirect('/users');
}
