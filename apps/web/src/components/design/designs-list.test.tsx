import { DESIGN_ROUTES, designTemplateDoc } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { th } from '@/messages/th';
import { DesignsList } from './designs-list';

const td = th.designs;

function renderList(fake: FakeApi) {
  const onOpen = vi.fn();
  const view = renderWithProviders(<DesignsList onOpen={onOpen} />, {
    api: apiClientFor(fake.fetch),
  });
  return { ...view, onOpen };
}

async function openMenu(name: string) {
  await userEvent.click(
    await screen.findByRole('button', { name: td.menu.replace('{name}', name) }),
  );
}

describe('studio: share page designs list (ADR 0013)', () => {
  it('lists designs with live previews, the default badge and the limits', async () => {
    const fake = new FakeApi();
    fake.designs.limits.maxDesigns = 3;
    fake.designs.add('Gala', designTemplateDoc('night-gala'), { isDefault: true });
    fake.designs.add('Poster', designTemplateDoc('bold-poster'));
    renderList(fake);
    const list = await screen.findByRole('list', { name: td.listLabel });
    const cards = within(list).getAllByRole('article');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Poster', 'Gala']);
    expect(within(cards[1] as HTMLElement).getByText(td.defaultBadge)).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).queryByText(td.defaultBadge)).toBeNull();
    // A live preview (the renderer itself) per card.
    expect(within(cards[0] as HTMLElement).getByText('EVENT PHOTOS')).toBeInTheDocument();
    expect(screen.getByText('2 จาก 3 แบบ')).toBeInTheDocument();
  });

  it('creates from a template (names by template id, placeholder text in the UI language) and opens it', async () => {
    const fake = new FakeApi();
    const { onOpen } = renderList(fake);
    await userEvent.click(await screen.findByRole('button', { name: td.create }));
    const dialog = await screen.findByRole('dialog', { name: td.picker.title });
    for (const name of Object.values(td.templates)) {
      expect(within(dialog).getByRole('radio', { name })).toBeInTheDocument();
    }
    await userEvent.click(
      within(dialog).getByRole('radio', { name: td.templates['tech-blue-glass'] }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: td.picker.create }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    expect(fake.callsTo(DESIGN_ROUTES.create)[0]?.body).toEqual({
      name: td.templates['tech-blue-glass'],
      templateId: 'tech-blue-glass',
      locale: 'th',
    });
    const created = [...fake.designs.designs.values()][0];
    expect(onOpen).toHaveBeenCalledWith(created?.id);
  });

  it('creates a blank design with a name', async () => {
    const fake = new FakeApi();
    renderList(fake);
    await userEvent.click(await screen.findByRole('button', { name: td.create }));
    const dialog = await screen.findByRole('dialog', { name: td.picker.title });
    await userEvent.click(within(dialog).getByRole('radio', { name: td.picker.blank }));
    await userEvent.type(within(dialog).getByLabelText(td.nameLabel), 'Run 2026');
    await userEvent.click(within(dialog).getByRole('button', { name: td.picker.create }));
    await waitFor(() => expect(fake.callsTo(DESIGN_ROUTES.create)).toHaveLength(1));
    expect(fake.callsTo(DESIGN_ROUTES.create)[0]?.body).toEqual({ name: 'Run 2026' });
  });

  it('renames, duplicates, sets and unsets the default', async () => {
    const fake = new FakeApi();
    const gala = fake.designs.add('Gala', designTemplateDoc('night-gala'));
    renderList(fake);
    await openMenu('Gala');
    await userEvent.click(await screen.findByRole('menuitem', { name: td.rename }));
    const rename = await screen.findByRole('dialog', { name: td.rename });
    const input = within(rename).getByLabelText(td.nameLabel);
    await userEvent.clear(input);
    await userEvent.type(input, 'Gala 2026');
    await userEvent.click(within(rename).getByRole('button', { name: th.common.save }));
    await waitFor(() => expect(fake.designs.designs.get(gala.id)?.name).toBe('Gala 2026'));
    expect(fake.callsTo(DESIGN_ROUTES.update)[0]?.body).toMatchObject({ revision: 1 });

    await openMenu('Gala 2026');
    await userEvent.click(await screen.findByRole('menuitem', { name: td.duplicate }));
    await waitFor(() => expect(fake.designs.designs.size).toBe(2));
    const copy = [...fake.designs.designs.values()].find((d) => d.id !== gala.id);
    expect(copy?.name).toBe('Gala 2026 (สำเนา)');
    expect(copy?.doc).toEqual(fake.designs.designs.get(gala.id)?.doc);

    await openMenu('Gala 2026');
    await userEvent.click(await screen.findByRole('menuitem', { name: td.makeDefault }));
    await waitFor(() => expect(fake.designs.designs.get(gala.id)?.isDefault).toBe(true));
    expect(fake.callsTo(DESIGN_ROUTES.setDefault)).toHaveLength(1);
    await openMenu('Gala 2026');
    await userEvent.click(await screen.findByRole('menuitem', { name: td.unsetDefault }));
    await waitFor(() => expect(fake.designs.designs.get(gala.id)?.isDefault).toBe(false));
    expect(fake.callsTo(DESIGN_ROUTES.clearDefault)).toHaveLength(1);
  });

  it('deletes only after confirming', async () => {
    const fake = new FakeApi();
    const gala = fake.designs.add('Gala');
    renderList(fake);
    await openMenu('Gala');
    await userEvent.click(await screen.findByRole('menuitem', { name: td.delete }));
    const confirm = await screen.findByRole('alertdialog', {
      name: td.deleteTitle.replace('{name}', 'Gala'),
    });
    expect(within(confirm).getByText(td.deleteBody)).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole('button', { name: th.common.cancel }));
    expect(fake.designs.designs.has(gala.id)).toBe(true);
    await openMenu('Gala');
    await userEvent.click(await screen.findByRole('menuitem', { name: td.delete }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: td.delete }),
    );
    await waitFor(() => expect(fake.designs.designs.has(gala.id)).toBe(false));
    expect(await screen.findByText(td.deleted)).toBeInTheDocument();
    expect(await screen.findByText(td.empty)).toBeInTheDocument();
  });

  it('at the limit: no create button, and a note', async () => {
    const fake = new FakeApi();
    fake.designs.limits.maxDesigns = 1;
    fake.designs.add('Only');
    renderList(fake);
    expect(
      await screen.findByText(td.limitReached.replace('{max, number}', '1')),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: td.create })).toBeDisabled();
  });
});
