import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A failed screenshot send can restore its attachment without replacing a newer draft",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("attachment-recovery");
    const thread = await t3.thread({ project, title: "Screenshot recovery", messages: ["Start"] });
    await t3.open(thread);

    const uploadStarted = Promise.withResolvers<void>();
    const failUpload = Promise.withResolvers<void>();
    let firstUpload = true;
    await browser.route("**/api/attachments/upload/*", async (route) => {
      if (!firstUpload) return route.continue();
      firstUpload = false;
      uploadStarted.resolve();
      await failUpload.promise;
      await route.fulfill({ status: 503, body: "Upload temporarily unavailable" });
    });

    const composer = screen.getByRole("textbox");
    await composer.fill("Review this screenshot");
    try {
      await browser.evaluate(`async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 240;
        canvas.height = 140;
        const context = canvas.getContext("2d");
        context.fillStyle = "#2f62d5";
        context.fillRect(0, 0, 240, 140);
        context.fillStyle = "#ffffff";
        context.font = "20px sans-serif";
        context.fillText("Recover this image", 24, 76);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve));
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File([blob], "pasted-screenshot.png", { type: "image/png" }));
        document
          .querySelector('[role="textbox"]')
          .dispatchEvent(
            new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
          );
        return null;
      }`);
      await uploadStarted.promise;
      await composer.press("Enter");
      await composer.fill("Next draft stays here");
      failUpload.resolve();

      await screen.getByText("Message not sent", { exact: true }).waitFor();
      await app.screenshot("failed-send");
      const restore = screen.getByRole("button", "Restore attachments");
      await expect(restore).toBeVisible();
      await restore.tap();
      await expect(composer).toHaveText("Next draft stays here");
      await expect(screen.getByRole("button", "Preview pasted-screenshot.png")).toBeVisible();
      await app.screenshot("recovered-attachment");
    } finally {
      failUpload.resolve();
    }
  },
);
