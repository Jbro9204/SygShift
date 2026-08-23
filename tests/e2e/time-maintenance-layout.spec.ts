import { expect, test } from "@playwright/test";

test("Time Maintenance fits the viewport and opens corrections in place", async ({
  page,
}) => {
  await page.goto("/");

  await page.locator("#root").evaluate((root) => {
    root.innerHTML = `
      <main style="max-width: 1280px; margin: 24px auto; padding: 0 18px;">
        <div class="time-review-table-wrap" data-testid="maintenance-wrap">
          <table class="time-review-table time-maintenance-table">
            <thead><tr><th>Workday / punch time</th><th>Punch</th><th>Site/Post</th><th>Status</th><th>Maintenance</th></tr></thead>
            <tbody><tr>
              <td><strong>Workday 08/15/2026</strong><span>08/16/2026 · 7:00 AM (07:00)</span></td>
              <td><strong>Clocked out</strong><span>supervisor</span></td>
              <td><strong>PERA-Denver - Armed</strong><span>PERA · Armed coverage</span></td>
              <td><strong>Active</strong><small>Overnight occurrence retained with 08/15/2026</small></td>
              <td><div class="time-maintenance-actions"><button class="secondary-button secondary-button--small">Add punch</button><button class="secondary-button secondary-button--small">Correct punch</button></div></td>
            </tr></tbody>
          </table>
        </div>
        <form class="time-maintenance-add" data-testid="manual-punch-form">
          <div><p class="eyebrow">Add missing punch</p><h3>Supervisor-entered time event</h3></div>
          <label><span>Employee</span><select><option>Marcos Lopez</option></select></label>
          <label><span>Punch type</span><select><option>Clock out</option></select></label>
          <label><span>Date</span><input type="date" value="2026-08-21" /></label>
          <label><span>Time / Mountain</span><input type="time" value="06:00" /></label>
          <div class="time-maintenance-add__site-post">
            <label><span>Site/Post</span><select><option>PERA · Denver - Armed coverage</option></select><small>Saved with this punch so a second Site/Post correction is not required.</small></label>
          </div>
          <label class="time-maintenance-add__reason">Reason<textarea>Verified missing clock-out.</textarea></label>
          <button class="primary-action">Add time event</button>
        </form>
        <dialog class="modal-dialog modal-dialog--time-workflow modal-dialog--time-correction" aria-label="Correct punch for Daron Jones">
          <div class="modal-dialog__heading"><div><h2>Correct punch</h2><p>Daron Jones · Workday 08/15/2026</p></div></div>
          <form class="time-correction-editor time-correction-editor--modal">
            <div><p class="eyebrow">Time correction</p><h3>Correct Daron Jones</h3></div>
            <div class="time-correction-editor__mode"><label><input type="radio" checked /> Change punch</label></div>
            <label class="time-maintenance-add__reason">Reason<textarea>Verified overnight shift</textarea></label>
            <div class="time-correction-editor__actions"><button class="secondary-button">Cancel</button><button class="primary-action">Save correction</button></div>
          </form>
        </dialog>
      </main>`;
    root.querySelector<HTMLDialogElement>("dialog")?.showModal();
  });

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const wrapperOverflow = await page
    .getByTestId("maintenance-wrap")
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(wrapperOverflow).toBeLessThanOrEqual(1);

  const punchForm = page.getByTestId("manual-punch-form");
  const punchFormOverflow = await punchForm.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(punchFormOverflow).toBeLessThanOrEqual(1);
  await expect(punchForm.getByText("Site/Post", { exact: true })).toBeVisible();

  const modal = page.getByRole("dialog", {
    name: "Correct punch for Daron Jones",
  });
  await expect(modal).toBeVisible();
  const modalBox = await modal.boundingBox();
  expect(modalBox).not.toBeNull();
  expect(modalBox!.x).toBeGreaterThanOrEqual(0);
  expect(modalBox!.y).toBeGreaterThanOrEqual(0);
  expect(modalBox!.x + modalBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(modalBox!.y + modalBox!.height).toBeLessThanOrEqual(viewport!.height);
});
