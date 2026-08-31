// The draining track, shared by the rest timer and the EMOM clock.
//
// One line of arithmetic, in one file, because it is not really arithmetic: it is the JS half of a
// CSS decision, and the two halves are useless apart. `.rest__fill` and `.emom__fill` in styles.css
// are full width bars that show less of themselves by sliding out to the left, so this converts a
// percentage remaining into how far left the bar has to sit. Both fills are declared `width: 100%`
// there, and that is the assumption this makes.
//
// Both tracks used to animate `width`, which lays the screen out again on every frame of the
// transition. That is the wrong cost on these two screens in particular: the rest timer is on the
// logging screen, read at arm's length mid set, and the EMOM track redraws four times a second for
// half an hour against a clock that cannot be paused. A transform runs on the compositor instead.
//
// It slides rather than scaling, and the reason is the glow. `.rest__fill` carries a measured
// 14px halo from the glow rules, and scaleX multiplies a box-shadow's horizontal blur along with
// the box, so the leading edge's halo would sharpen toward nothing as the timer ran down. That
// radius is measured rather than chosen, per the Glow section of CLAUDE.md. A translation carries
// the bar and its light rigidly, and both tracks sit inside a container that clips, so what ends up
// on screen is identical to what the width version drew.
//
// percent is 0 to 100 and means how much of the track is still filled. 100 sits at rest, 0 is one
// whole length off screen to the left.
export function trackFill(percent) {
  return `translateX(${percent - 100}%)`;
}
