import {
  blankDesignDoc,
  DESIGN_ROUTES,
  type DesignDoc,
  designDocSchema,
  designTemplateDoc,
} from '@shotx/shared';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeApi } from '../../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../../test/render';
import { useAutosave } from '@/lib/design/use-autosave';
import { th } from '@/messages/th';
import { DesignEditorPage, type DesignEditorRuntime } from './design-editor';

const te = th.designs.editor;

function runtimeFor(fake: FakeApi): DesignEditorRuntime {
  return {
    autosaveDelayMs: 20,
    assetPollMs: 10,
    putObject: fake.designs.storageFetch,
    sleep: () => Promise.resolve(),
    pollIntervalMs: 0,
  };
}

function renderEditor(fake: FakeApi, designId: string) {
  return renderWithProviders(<DesignEditorPage designId={designId} runtime={runtimeFor(fake)} />, {
    api: apiClientFor(fake.fetch),
  });
}

/** The last document PUT /designs/:id saved. */
function lastSaved(fake: FakeApi): { doc: DesignDoc; revision: number; name: string } {
  const calls = fake.callsTo(DESIGN_ROUTES.update);
  return calls.at(-1)?.body as { doc: DesignDoc; revision: number; name: string };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('autosave (ADR 0013)', () => {
  it('saves 1 s after the last change with the revision, then uses the new revision', async () => {
    vi.useFakeTimers();
    const fake = new FakeApi();
    const design = fake.designs.add('Event');
    const api = apiClientFor(fake.fetch);
    const limits = { maxElements: 60, docMaxBytes: 65536 };
    const doc = blankDesignDoc();
    const { result, rerender } = renderHook(
      (props: { version: number; doc: DesignDoc; name: string }) =>
        useAutosave({
          api,
          designId: design.id,
          doc: props.doc,
          name: props.name,
          version: props.version,
          baseVersion: 0,
          revision: design.revision,
          limits,
        }),
      { initialProps: { version: 0, doc, name: 'Event' } },
    );
    expect(result.current.status).toBe('saved');
    rerender({ version: 1, doc, name: 'Event 2' });
    expect(result.current.status).toBe('unsaved');
    await act(() => vi.advanceTimersByTimeAsync(600));
    // Another change restarts the wait.
    rerender({ version: 2, doc, name: 'Event 3' });
    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(fake.callsTo(DESIGN_ROUTES.update)).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(1));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fake.callsTo(DESIGN_ROUTES.update)).toHaveLength(1);
    expect(lastSaved(fake)).toMatchObject({ name: 'Event 3', revision: 1 });
    expect(result.current.status).toBe('saved');
    expect(fake.designs.designs.get(design.id)?.revision).toBe(2);

    rerender({ version: 3, doc, name: 'Event 4' });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(lastSaved(fake)).toMatchObject({ name: 'Event 4', revision: 2 });

    // An invalid document (empty name) is not sent.
    rerender({ version: 4, doc, name: '   ' });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(result.current.status).toBe('invalid');
    expect(fake.callsTo(DESIGN_ROUTES.update)).toHaveLength(2);
  });
});

describe('design editor', () => {
  it('a revision conflict stops autosave and offers to reload the latest', async () => {
    const fake = new FakeApi();
    const design = fake.designs.add('Event');
    renderEditor(fake, design.id);
    const name = await screen.findByRole('textbox', { name: te.name });
    // Someone saved in another tab.
    const server = fake.designs.designs.get(design.id);
    if (server === undefined) throw new Error('seeded');
    fake.designs.designs.set(design.id, {
      ...server,
      name: 'Saved elsewhere',
      revision: 5,
      doc: designTemplateDoc('night-gala'),
    });
    await userEvent.type(name, ' 2026');
    const alert = await screen.findByText(te.status.conflict);
    // The first save after typing started (one or more keys in) sent the stale revision.
    expect(lastSaved(fake).revision).toBe(1);
    expect(lastSaved(fake).name).toMatch(/^Event/);
    expect(fake.callsTo(DESIGN_ROUTES.update)).toHaveLength(1);
    await userEvent.click(
      within(alert.parentElement as HTMLElement).getByRole('button', { name: te.status.reload }),
    );
    // The editor starts again from the stored design.
    expect(await screen.findByDisplayValue('Saved elsewhere')).toBeInTheDocument();
    expect(screen.queryByText(te.status.conflict)).toBeNull();
    await userEvent.type(screen.getByRole('textbox', { name: te.name }), '!');
    await waitFor(() =>
      expect(lastSaved(fake)).toMatchObject({ revision: 5, name: 'Saved elsewhere!' }),
    );
    await waitFor(() => expect(screen.getByText(te.status.saved)).toBeInTheDocument());
  });

  it('keyboard shortcuts edit the design, and are off while typing', async () => {
    const fake = new FakeApi();
    const design = fake.designs.add('Event');
    renderEditor(fake, design.id);
    const name = await screen.findByRole('textbox', { name: te.name });
    const count = () => fake.designs.designs.get(design.id)?.doc.elements.length ?? 0;
    const before = design.doc.elements.length;

    // R adds a rectangle (selected), Delete removes it, Ctrl+Z brings it back.
    await userEvent.keyboard('r');
    await waitFor(() => expect(count()).toBe(before + 1));
    await userEvent.keyboard('{Delete}');
    await waitFor(() => expect(count()).toBe(before));
    await userEvent.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(count()).toBe(before + 1));
    // Ctrl+D duplicates the selection.
    await userEvent.keyboard('{Control>}d{/Control}');
    await waitFor(() => expect(count()).toBe(before + 2));

    // Typing in the name field: letters are text, not shortcuts.
    await userEvent.click(name);
    await userEvent.keyboard('rte{Backspace}');
    await waitFor(() => expect(fake.designs.designs.get(design.id)?.name).toBe('Eventrt'));
    expect(count()).toBe(before + 2);

    // The face icon can't be deleted: a note says why.
    name.blur();
    await userEvent.click(screen.getByRole('tab', { name: te.panels.layers }));
    await userEvent.click(screen.getByRole('button', { name: te.layers.types.faceIcon }));
    await userEvent.keyboard('{Delete}');
    expect(
      await screen.findByText(te.props.cantDelete, { selector: '[role="status"]' }),
    ).toBeInTheDocument();
    expect(count()).toBe(before + 2);

    // ? lists the shortcuts.
    await userEvent.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: te.shortcutsDialog.title });
    expect(within(dialog).getByText(te.shortcutsDialog.items.duplicate)).toBeInTheDocument();
    expect(within(dialog).getByText('Ctrl+D')).toBeInTheDocument();
  });

  it('double-click a text to edit it in place; shortcuts stay off while editing', async () => {
    const fake = new FakeApi();
    const design = fake.designs.add('Event', designTemplateDoc('clean-white-card'));
    const { container } = renderEditor(fake, design.id);
    await screen.findByRole('textbox', { name: te.name });
    const hit = container.querySelector('[data-hit-id="title"]') as HTMLElement;
    fireEvent.doubleClick(hit);
    const editor = await screen.findByRole('textbox', { name: te.textEditor });
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Run Bangkok');
    await waitFor(() => {
      const title = fake.designs.designs.get(design.id)?.doc.elements.find((e) => e.id === 'title');
      expect(title).toMatchObject({ text: 'Run Bangkok' });
    });
    // `r`, `e`, `t` typed above added nothing.
    expect(fake.designs.designs.get(design.id)?.doc.elements).toHaveLength(
      design.doc.elements.length,
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: te.textEditor })).toBeNull();
  });

  it('uploads an image straight to the bucket, waits until ready, adds it and saves its id', async () => {
    const fake = new FakeApi();
    fake.designs.pollsUntilReady = 2;
    const earlier = fake.designs.addAsset('ready');
    const design = fake.designs.add('Event');
    renderEditor(fake, design.id);
    await userEvent.click(await screen.findByRole('tab', { name: te.panels.uploads }));
    // Earlier uploads can be reused.
    const list = await screen.findByRole('list', { name: te.uploads.listLabel });
    expect(within(list).getAllByRole('button', { name: te.uploads.add })).toHaveLength(1);

    const file = new File([new Uint8Array(2048)], 'logo.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText(te.uploads.pick), file);

    await waitFor(() => expect(fake.designs.puts).toHaveLength(1));
    const created = fake.callsTo(DESIGN_ROUTES.createAsset)[0];
    expect(created).toMatchObject({
      prefix: '/bff',
      body: { fileName: 'logo.png', mime: 'image/png', sizeBytes: 2048 },
    });
    expect(fake.designs.puts[0]).toMatchObject({ size: 2048, contentType: 'image/png' });
    await waitFor(() => expect(fake.callsTo(DESIGN_ROUTES.completeAsset)).toHaveLength(1));
    // Saved with the new image element referencing the asset.
    await waitFor(() => {
      const saved = lastSaved(fake);
      expect(saved?.doc.elements.some((e) => e.type === 'image')).toBe(true);
    });
    const saved = lastSaved(fake);
    expect(designDocSchema.safeParse(saved.doc).success).toBe(true);
    const image = saved.doc.elements.find((e) => e.type === 'image');
    const assetId = image?.type === 'image' ? image.assetId : '';
    expect(fake.designs.assets.get(assetId)?.view.status).toBe('ready');
    expect(fake.callsTo(DESIGN_ROUTES.getAsset).length).toBeGreaterThanOrEqual(2);
    // The image is drawn from its signed URL (ratio 800 x 400: 240 x 120).
    expect(image).toMatchObject({ w: 240, h: 120 });
    expect(document.querySelector(`img[src*="${assetId}/web.webp"]`)).not.toBeNull();
    expect(earlier.id).not.toBe(assetId);
  });

  it('refuses a file type the API would refuse, before any call', async () => {
    const fake = new FakeApi();
    const design = fake.designs.add('Event');
    renderEditor(fake, design.id);
    await userEvent.click(await screen.findByRole('tab', { name: te.panels.uploads }));
    const file = new File(['x'], 'photo.heic', { type: 'image/heic' });
    await userEvent.upload(screen.getByLabelText(te.uploads.pick), file, { applyAccept: false });
    expect(
      await screen.findByText((text) => text.includes(th.errors.hints.heic)),
    ).toBeInTheDocument();
    expect(fake.callsTo(DESIGN_ROUTES.createAsset)).toHaveLength(0);
  });

  it('undo and redo buttons, and the preview in another language and mode', async () => {
    const fake = new FakeApi();
    const design = fake.designs.add('Event', designTemplateDoc('pastel-glow'));
    renderEditor(fake, design.id);
    const undo = await screen.findByRole('button', { name: te.undo });
    expect(undo).toBeDisabled();
    await userEvent.click(screen.getByRole('tab', { name: te.panels.shapes }));
    await userEvent.click(screen.getByRole('button', { name: te.shapes.ellipse }));
    expect(undo).toBeEnabled();
    await userEvent.click(undo);
    expect(screen.getByRole('button', { name: te.redo })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: te.preview }));
    const dialog = await screen.findByRole('dialog', { name: te.previewDialog.title });
    const frame = within(dialog).getByTestId('design-preview-frame');
    expect(within(frame).getByText(th.share.design.choosePhoto)).toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText(te.previewDialog.language), 'en');
    await userEvent.selectOptions(
      within(dialog).getByLabelText(te.previewDialog.mode),
      'face_only',
    );
    expect(within(frame).getByText('Take a selfie')).toBeInTheDocument();
    expect(within(frame).queryByText('Use a photo')).toBeNull();
  });
});
