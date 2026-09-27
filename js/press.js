// Presses on an iPhone.
//
// Safari on iOS applies :active to an element only when a touch listener is registered on it or on
// something above it. Without one, a tap changes nothing on screen until the click lands, so every
// press in styles.css showed only on the stepper keys, which carry a pointerdown listener of their
// own for hold to repeat, and nowhere else. Desktop browsers have no such rule, which is why it
// looked finished everywhere but on the phone it was for.
//
// One passive, empty listener on the document is the whole fix. It does nothing, it cannot hold up
// a scroll because it is passive, and it turns :active on for every control on the page. Every
// page imports this file for that side effect alone.
document.addEventListener('touchstart', () => {}, { passive: true });
