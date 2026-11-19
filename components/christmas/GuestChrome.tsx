// Someone in on the Christmas passcode alone (Kim) has no use for the hub's
// masthead and side rail — every link there leads to the hub's own login. The
// server renders this only when the visitor is NOT logged in to the hub, so
// the owner keeps his navigation and Kim gets the page on its own.
export default function GuestChrome() {
  return (
    <style>{`
      .hub-masthead, #hub-sidenav { display: none !important; }
      body:has(#hub-sidenav) .hub-shell { padding-left: 0 !important; }
      .xmas { --top: 16px; padding-top: calc(20px + env(safe-area-inset-top, 0px)) !important; }
    `}</style>
  );
}
