"use client";

import { useState } from "react";
import type { ResolvedContact } from "@/features/commitments/commitment-contact";
import {
  contactMessageSubject,
  draftContactMessage,
  mailtoHref,
  smsHref,
  type ContactMessageContext
} from "@/features/commitments/contact-message";

/**
 * The prefilled message on the **Something came up** sheet. It
 * drafts the words from why the offer was made, lets the person edit them, and hands them to the
 * person's own messaging app: **Text Sam** and **Email Sam** are `sms:`/`mailto:` links, and **Share…**
 * is the device's share sheet where the browser has one. OpenRhen sends nothing and records nothing;
 * the person presses send in their own app, or doesn't.
 *
 * With no phone, email or share sheet there is nothing to hand over, so it says so and points at
 * Settings, where a contact's phone and email live.
 *
 * The caller keys this on the contact, so choosing someone else starts a fresh draft addressed to them.
 */
export function ContactMessageComposer({
  contact,
  context
}: {
  contact: ResolvedContact;
  context: ContactMessageContext;
}) {
  const [body, setBody] = useState(() => draftContactMessage(contact.name, context));
  const [shareError, setShareError] = useState("");
  const text = contact.phone ? smsHref(contact.phone, body) : undefined;
  const mail = contact.email ? mailtoHref(contact.email, contactMessageSubject(context), body) : undefined;
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  if (!text && !mail && !canShare) {
    return (
      <p className="microcopy">
        OpenRhen doesn&rsquo;t message {contact.name}. Tell them yourself, or add their phone or email in Settings to
        get the message written for you.
      </p>
    );
  }

  async function share() {
    setShareError("");
    try {
      await navigator.share({ text: body });
    } catch (error) {
      // Dismissing the share sheet is not a failure worth a line.
      if (error instanceof DOMException && error.name === "AbortError") return;
      setShareError("Couldn't open the share sheet. Copy the message instead.");
    }
  }

  return (
    <div className="contact-message">
      <label className="field wide">
        <span>Message to {contact.name}</span>
        <textarea rows={3} value={body} onChange={(event) => setBody(event.target.value)} />
      </label>
      <div className="actions">
        {text && (
          <a className="button-link" href={text}>
            Text {contact.name}
          </a>
        )}
        {mail && (
          <a className="button-link" href={mail}>
            Email {contact.name}
          </a>
        )}
        {canShare && (
          <button type="button" className="quiet small" onClick={() => void share()}>
            Share…
          </button>
        )}
      </div>
      <p className="microcopy">
        OpenRhen doesn&rsquo;t send this. Your own app opens with it written, and you press send.
      </p>
      {shareError && <p className="form-error">{shareError}</p>}
    </div>
  );
}
