/**
 * Who may ask for which curve.
 *
 * ⚡ activity looks like one section with one toggle and is not: three of its
 * five metrics plot ANOTHER section's headline over time. So a profile with 💎
 * value hidden and ⚡ activity public was answering `?metric=value` with the
 * dollars the page itself refuses to print, and drawing them in its own footer
 * and aria-label on the way in.
 *
 * These are the functions the route and the panel both read — the endpoint's
 * 404 and the rendered controls are the same decision, made once here.
 */

import { describe, expect, it } from 'bun:test';
import { FINGERPRINT_SECTIONS, type FingerprintSection } from '../../lib/fingerprint';
import { defaultVisibility } from '../../lib/profile-settings';
import {
  CURVE_METRICS,
  CURVE_METRIC_SECTION,
  curveIsVisible,
  defaultCurveMetric,
  visibleCurveMetrics,
  type CurveMetric,
} from './curve';

/** Everything public except the named sections. */
function visibilityWithout(...hidden: FingerprintSection[]) {
  const visibility = defaultVisibility();
  for (const section of hidden) visibility[section] = false;
  return visibility;
}

describe('CURVE_METRIC_SECTION', () => {
  it('gives every metric an owning section that can actually be hidden', () => {
    for (const metric of CURVE_METRICS) {
      const section = CURVE_METRIC_SECTION[metric];
      expect(FINGERPRINT_SECTIONS).toContain(section);
    }
  });

  it("maps the three borrowed figures to the sections they belong to", () => {
    expect(CURVE_METRIC_SECTION.value).toBe('value');
    expect(CURVE_METRIC_SECTION.lines).toBe('anatomy');
    expect(CURVE_METRIC_SECTION.ultrathinks).toBe('ultrathink');
    // The curve's own two, which need no second toggle.
    expect(CURVE_METRIC_SECTION.prompts).toBe('curve');
    expect(CURVE_METRIC_SECTION.toolCalls).toBe('curve');
  });
});

describe('curveIsVisible', () => {
  it('lets a visitor see everything on a profile that hides nothing', () => {
    for (const metric of CURVE_METRICS) {
      expect(curveIsVisible(defaultVisibility(), metric)).toBe(true);
    }
  });

  it('refuses every metric when the panel itself is hidden', () => {
    const visibility = visibilityWithout('curve');
    for (const metric of CURVE_METRICS) {
      expect(curveIsVisible(visibility, metric)).toBe(false);
    }
  });

  // The finding, metric by metric: hiding the SECTION has to close the chart
  // that draws it, and close nothing else.
  it.each([
    ['value', 'value'],
    ['anatomy', 'lines'],
    ['ultrathink', 'ultrathinks'],
  ] as const)("hiding '%s' closes only ?metric=%s", (section, closed) => {
    const visibility = visibilityWithout(section);
    for (const metric of CURVE_METRICS) {
      expect(curveIsVisible(visibility, metric)).toBe(metric !== closed);
    }
  });
});

describe('visibleCurveMetrics', () => {
  it('keeps the controls in their own order', () => {
    expect(visibleCurveMetrics(defaultVisibility())).toEqual([...CURVE_METRICS]);
  });

  it('leaves a visitor the two the curve owns when the other three are down', () => {
    expect(visibleCurveMetrics(visibilityWithout('value', 'anatomy', 'ultrathink'))).toEqual([
      'prompts',
      'toolCalls',
    ]);
  });

  it('never offers a metric the endpoint would 404', () => {
    // Every subset of the three borrowing sections, which is the whole space
    // of disagreements between the buttons and the route.
    const borrowed: FingerprintSection[] = ['value', 'anatomy', 'ultrathink', 'curve'];
    for (let mask = 0; mask < 1 << borrowed.length; mask++) {
      const hidden = borrowed.filter((_, index) => mask & (1 << index));
      const visibility = visibilityWithout(...hidden);
      for (const metric of visibleCurveMetrics(visibility)) {
        expect(curveIsVisible(visibility, metric)).toBe(true);
      }
    }
  });
});

describe('defaultCurveMetric', () => {
  it('opens on the preferred metric when its section is public', () => {
    expect(defaultCurveMetric('value', defaultVisibility())).toBe('value');
  });

  it('falls back to prompts, which the panel gates on its own toggle', () => {
    for (const preferred of CURVE_METRICS) {
      const fallback = defaultCurveMetric(
        preferred,
        visibilityWithout('value', 'anatomy', 'ultrathink')
      );
      expect(fallback === preferred || fallback === 'prompts').toBe(true);
      expect(curveIsVisible(visibilityWithout('value', 'anatomy', 'ultrathink'), fallback)).toBe(
        true
      );
    }
  });

  it('is a metric the controls would also render', () => {
    const visibility = visibilityWithout('value');
    const opened: CurveMetric = defaultCurveMetric('value', visibility);
    expect(visibleCurveMetrics(visibility)).toContain(opened);
  });
});
