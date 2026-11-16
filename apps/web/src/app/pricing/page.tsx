import { PACKAGES_SECTION_PATH } from '@shotx/shared';
import { redirect } from 'next/navigation';

/** ADR 0026: the old pricing page; the packages are on the home page now. */
export default function PricingPage() {
  redirect(PACKAGES_SECTION_PATH);
}
