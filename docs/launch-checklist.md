# Launch checklist (owner decisions)

Software cannot make these decisions for the cafe. Each item must be confirmed by the owner,
ideally with a qualified accountant or adviser, **before real customers pay real money**.
This list is a prompt for those conversations, not legal or tax advice.

## Pricing and tax

- [ ] Are menu prices tax-inclusive or tax-exclusive? v1 of the app assumes the configured
      menu price is the final price and shows one total with no tax breakdown.
- [ ] Does the cafe need to show a tax breakdown, a GST number, or issue a tax invoice or
      bill for each order? If yes, that is additional work beyond v1.
- [ ] Are there any service charges, discounts or rounding rules to apply? v1 has none.
- [ ] Who keeps the records the cafe must retain, and for how long? (Orders and payment
      references are stored in the database; export and retention are not built yet.)

## Payments

- [ ] Razorpay account created and business verification (KYC) completed for live payments.
- [ ] Settlement bank account and settlement schedule confirmed.
- [ ] Payment methods enabled in the Razorpay Dashboard (UPI, cards, netbanking, wallets).
- [ ] Refund policy decided: who can authorise a refund, in which cases, and the timeline
      shown to customers. The app only marks an order refunded after Razorpay confirms it.
- [ ] Live-mode keys and webhook secret stored **only** as server environment variables on
      the hosting platform, never in source control, chat or screenshots.

## Customer data and notices

- [ ] The only personal data collected is an optional name. Confirm whether the cafe needs a
      privacy notice or consent wording for that, and where it is shown.
- [ ] How long order records (including names) are kept, and who can see them.

## Cafe operations

- [ ] Food-business licence and any display requirements confirmed for the premises.
- [ ] Menu items, prices, allergen and ingredient information checked for accuracy.
- [ ] What staff do when the internet or the app is down (fall back to taking orders at the
      counter).
- [ ] Who may create staff accounts, how a leaver's access is removed, and who is the
      second administrator if the manager is unavailable.
- [ ] Staff sign in with an email and password. Each person has their own account (never a
      shared login), a password of 12+ characters kept in a password manager, and signs out of
      shared counter devices at the end of a shift. Deactivating a profile locks a person out
      on their next request.
- [ ] Hosted Supabase: public sign-ups are switched **off** (Authentication settings), the Auth
      rate limits are reviewed, and the first manager was created by an administrator
      (`docs/staff-auth.md`).
- [ ] `APP_BASE_URL` is the final public https address **before** QR codes are downloaded
      (the app refuses to export QR codes that point at localhost in production).
- [ ] Every table in the cafe exists under Cafe tables and QR codes, with the right code and name;
      tables no longer in use are deactivated.
- [ ] QR codes printed, laminated and fixed to the correct tables, then each scanned on a
      real phone to confirm it opens the right table.

## Hosting

- [ ] Production domain and https configured; `NEXT_PUBLIC_APP_URL` and `APP_BASE_URL` set to that origin.
- [ ] Hosted Supabase project on a suitable plan, with backups enabled.
- [ ] Billing alerts set up on every paid service.
