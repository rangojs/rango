/**
 * Type stress test:
 * - 35 routes per level × 6 nested layouts = 210 routes
 * - 300 routes included at root level
 * - 300 routes included inside layout level 2
 * - 300 routes included inside layout level 5
 * Total: 1110 routes testing both nesting and include()
 */
import { urls } from "@rangojs/router";
import { patterns300 } from "./patterns-300";

const Page = () => null;
const Layout = <div />;

const stressTestPatterns = urls(({ path, layout, include }) => [
  // Include at root level
  include("/inc0", patterns300, { name: "inc0" }),
  path("/l1/1", Page, { name: "l1.r1" }),
  path("/l1/2", Page, { name: "l1.r2" }),
  path("/l1/3", Page, { name: "l1.r3" }),
  path("/l1/4", Page, { name: "l1.r4" }),
  path("/l1/5", Page, { name: "l1.r5" }),
  path("/l1/6", Page, { name: "l1.r6" }),
  path("/l1/7", Page, { name: "l1.r7" }),
  path("/l1/8", Page, { name: "l1.r8" }),
  path("/l1/9", Page, { name: "l1.r9" }),
  path("/l1/10", Page, { name: "l1.r10" }),
  path("/l1/11", Page, { name: "l1.r11" }),
  path("/l1/12", Page, { name: "l1.r12" }),
  path("/l1/13", Page, { name: "l1.r13" }),
  path("/l1/14", Page, { name: "l1.r14" }),
  path("/l1/15", Page, { name: "l1.r15" }),
  path("/l1/16", Page, { name: "l1.r16" }),
  path("/l1/17", Page, { name: "l1.r17" }),
  path("/l1/18", Page, { name: "l1.r18" }),
  path("/l1/19", Page, { name: "l1.r19" }),
  path("/l1/20", Page, { name: "l1.r20" }),
  path("/l1/21", Page, { name: "l1.r21" }),
  path("/l1/22", Page, { name: "l1.r22" }),
  path("/l1/23", Page, { name: "l1.r23" }),
  path("/l1/24", Page, { name: "l1.r24" }),
  path("/l1/25", Page, { name: "l1.r25" }),
  path("/l1/26", Page, { name: "l1.r26" }),
  path("/l1/27", Page, { name: "l1.r27" }),
  path("/l1/28", Page, { name: "l1.r28" }),
  path("/l1/29", Page, { name: "l1.r29" }),
  path("/l1/30", Page, { name: "l1.r30" }),
  path("/l1/31", Page, { name: "l1.r31" }),
  path("/l1/32", Page, { name: "l1.r32" }),
  path("/l1/33", Page, { name: "l1.r33" }),
  path("/l1/34", Page, { name: "l1.r34" }),
  path("/l1/35", Page, { name: "l1.r35" }),
  layout(Layout, () => [
    path("/l2/1", Page, { name: "l2.r1" }),
    path("/l2/2", Page, { name: "l2.r2" }),
    path("/l2/3", Page, { name: "l2.r3" }),
    path("/l2/4", Page, { name: "l2.r4" }),
    path("/l2/5", Page, { name: "l2.r5" }),
    path("/l2/6", Page, { name: "l2.r6" }),
    path("/l2/7", Page, { name: "l2.r7" }),
    path("/l2/8", Page, { name: "l2.r8" }),
    path("/l2/9", Page, { name: "l2.r9" }),
    path("/l2/10", Page, { name: "l2.r10" }),
    path("/l2/11", Page, { name: "l2.r11" }),
    path("/l2/12", Page, { name: "l2.r12" }),
    path("/l2/13", Page, { name: "l2.r13" }),
    path("/l2/14", Page, { name: "l2.r14" }),
    path("/l2/15", Page, { name: "l2.r15" }),
    path("/l2/16", Page, { name: "l2.r16" }),
    path("/l2/17", Page, { name: "l2.r17" }),
    path("/l2/18", Page, { name: "l2.r18" }),
    path("/l2/19", Page, { name: "l2.r19" }),
    path("/l2/20", Page, { name: "l2.r20" }),
    path("/l2/21", Page, { name: "l2.r21" }),
    path("/l2/22", Page, { name: "l2.r22" }),
    path("/l2/23", Page, { name: "l2.r23" }),
    path("/l2/24", Page, { name: "l2.r24" }),
    path("/l2/25", Page, { name: "l2.r25" }),
    path("/l2/26", Page, { name: "l2.r26" }),
    path("/l2/27", Page, { name: "l2.r27" }),
    path("/l2/28", Page, { name: "l2.r28" }),
    path("/l2/29", Page, { name: "l2.r29" }),
    path("/l2/30", Page, { name: "l2.r30" }),
    path("/l2/31", Page, { name: "l2.r31" }),
    path("/l2/32", Page, { name: "l2.r32" }),
    path("/l2/33", Page, { name: "l2.r33" }),
    path("/l2/34", Page, { name: "l2.r34" }),
    path("/l2/35", Page, { name: "l2.r35" }),
    // Include at layout level 2
    include("/inc2", patterns300, { name: "inc2" }),
    layout(Layout, () => [
      path("/l3/1", Page, { name: "l3.r1" }),
      path("/l3/2", Page, { name: "l3.r2" }),
      path("/l3/3", Page, { name: "l3.r3" }),
      path("/l3/4", Page, { name: "l3.r4" }),
      path("/l3/5", Page, { name: "l3.r5" }),
      path("/l3/6", Page, { name: "l3.r6" }),
      path("/l3/7", Page, { name: "l3.r7" }),
      path("/l3/8", Page, { name: "l3.r8" }),
      path("/l3/9", Page, { name: "l3.r9" }),
      path("/l3/10", Page, { name: "l3.r10" }),
      path("/l3/11", Page, { name: "l3.r11" }),
      path("/l3/12", Page, { name: "l3.r12" }),
      path("/l3/13", Page, { name: "l3.r13" }),
      path("/l3/14", Page, { name: "l3.r14" }),
      path("/l3/15", Page, { name: "l3.r15" }),
      path("/l3/16", Page, { name: "l3.r16" }),
      path("/l3/17", Page, { name: "l3.r17" }),
      path("/l3/18", Page, { name: "l3.r18" }),
      path("/l3/19", Page, { name: "l3.r19" }),
      path("/l3/20", Page, { name: "l3.r20" }),
      path("/l3/21", Page, { name: "l3.r21" }),
      path("/l3/22", Page, { name: "l3.r22" }),
      path("/l3/23", Page, { name: "l3.r23" }),
      path("/l3/24", Page, { name: "l3.r24" }),
      path("/l3/25", Page, { name: "l3.r25" }),
      path("/l3/26", Page, { name: "l3.r26" }),
      path("/l3/27", Page, { name: "l3.r27" }),
      path("/l3/28", Page, { name: "l3.r28" }),
      path("/l3/29", Page, { name: "l3.r29" }),
      path("/l3/30", Page, { name: "l3.r30" }),
      path("/l3/31", Page, { name: "l3.r31" }),
      path("/l3/32", Page, { name: "l3.r32" }),
      path("/l3/33", Page, { name: "l3.r33" }),
      path("/l3/34", Page, { name: "l3.r34" }),
      path("/l3/35", Page, { name: "l3.r35" }),
      layout(Layout, () => [
        path("/l4/1", Page, { name: "l4.r1" }),
        path("/l4/2", Page, { name: "l4.r2" }),
        path("/l4/3", Page, { name: "l4.r3" }),
        path("/l4/4", Page, { name: "l4.r4" }),
        path("/l4/5", Page, { name: "l4.r5" }),
        path("/l4/6", Page, { name: "l4.r6" }),
        path("/l4/7", Page, { name: "l4.r7" }),
        path("/l4/8", Page, { name: "l4.r8" }),
        path("/l4/9", Page, { name: "l4.r9" }),
        path("/l4/10", Page, { name: "l4.r10" }),
        path("/l4/11", Page, { name: "l4.r11" }),
        path("/l4/12", Page, { name: "l4.r12" }),
        path("/l4/13", Page, { name: "l4.r13" }),
        path("/l4/14", Page, { name: "l4.r14" }),
        path("/l4/15", Page, { name: "l4.r15" }),
        path("/l4/16", Page, { name: "l4.r16" }),
        path("/l4/17", Page, { name: "l4.r17" }),
        path("/l4/18", Page, { name: "l4.r18" }),
        path("/l4/19", Page, { name: "l4.r19" }),
        path("/l4/20", Page, { name: "l4.r20" }),
        path("/l4/21", Page, { name: "l4.r21" }),
        path("/l4/22", Page, { name: "l4.r22" }),
        path("/l4/23", Page, { name: "l4.r23" }),
        path("/l4/24", Page, { name: "l4.r24" }),
        path("/l4/25", Page, { name: "l4.r25" }),
        path("/l4/26", Page, { name: "l4.r26" }),
        path("/l4/27", Page, { name: "l4.r27" }),
        path("/l4/28", Page, { name: "l4.r28" }),
        path("/l4/29", Page, { name: "l4.r29" }),
        path("/l4/30", Page, { name: "l4.r30" }),
        path("/l4/31", Page, { name: "l4.r31" }),
        path("/l4/32", Page, { name: "l4.r32" }),
        path("/l4/33", Page, { name: "l4.r33" }),
        path("/l4/34", Page, { name: "l4.r34" }),
        path("/l4/35", Page, { name: "l4.r35" }),
        layout(Layout, () => [
          path("/l5/1", Page, { name: "l5.r1" }),
          path("/l5/2", Page, { name: "l5.r2" }),
          path("/l5/3", Page, { name: "l5.r3" }),
          path("/l5/4", Page, { name: "l5.r4" }),
          path("/l5/5", Page, { name: "l5.r5" }),
          path("/l5/6", Page, { name: "l5.r6" }),
          path("/l5/7", Page, { name: "l5.r7" }),
          path("/l5/8", Page, { name: "l5.r8" }),
          path("/l5/9", Page, { name: "l5.r9" }),
          path("/l5/10", Page, { name: "l5.r10" }),
          path("/l5/11", Page, { name: "l5.r11" }),
          path("/l5/12", Page, { name: "l5.r12" }),
          path("/l5/13", Page, { name: "l5.r13" }),
          path("/l5/14", Page, { name: "l5.r14" }),
          path("/l5/15", Page, { name: "l5.r15" }),
          path("/l5/16", Page, { name: "l5.r16" }),
          path("/l5/17", Page, { name: "l5.r17" }),
          path("/l5/18", Page, { name: "l5.r18" }),
          path("/l5/19", Page, { name: "l5.r19" }),
          path("/l5/20", Page, { name: "l5.r20" }),
          path("/l5/21", Page, { name: "l5.r21" }),
          path("/l5/22", Page, { name: "l5.r22" }),
          path("/l5/23", Page, { name: "l5.r23" }),
          path("/l5/24", Page, { name: "l5.r24" }),
          path("/l5/25", Page, { name: "l5.r25" }),
          path("/l5/26", Page, { name: "l5.r26" }),
          path("/l5/27", Page, { name: "l5.r27" }),
          path("/l5/28", Page, { name: "l5.r28" }),
          path("/l5/29", Page, { name: "l5.r29" }),
          path("/l5/30", Page, { name: "l5.r30" }),
          path("/l5/31", Page, { name: "l5.r31" }),
          path("/l5/32", Page, { name: "l5.r32" }),
          path("/l5/33", Page, { name: "l5.r33" }),
          path("/l5/34", Page, { name: "l5.r34" }),
          path("/l5/35", Page, { name: "l5.r35" }),
          // Include at layout level 5
          include("/inc5", patterns300, { name: "inc5" }),
          layout(Layout, () => [
            path("/l6/1", Page, { name: "l6.r1" }),
            path("/l6/2", Page, { name: "l6.r2" }),
            path("/l6/3", Page, { name: "l6.r3" }),
            path("/l6/4", Page, { name: "l6.r4" }),
            path("/l6/5", Page, { name: "l6.r5" }),
            path("/l6/6", Page, { name: "l6.r6" }),
            path("/l6/7", Page, { name: "l6.r7" }),
            path("/l6/8", Page, { name: "l6.r8" }),
            path("/l6/9", Page, { name: "l6.r9" }),
            path("/l6/10", Page, { name: "l6.r10" }),
            path("/l6/11", Page, { name: "l6.r11" }),
            path("/l6/12", Page, { name: "l6.r12" }),
            path("/l6/13", Page, { name: "l6.r13" }),
            path("/l6/14", Page, { name: "l6.r14" }),
            path("/l6/15", Page, { name: "l6.r15" }),
            path("/l6/16", Page, { name: "l6.r16" }),
            path("/l6/17", Page, { name: "l6.r17" }),
            path("/l6/18", Page, { name: "l6.r18" }),
            path("/l6/19", Page, { name: "l6.r19" }),
            path("/l6/20", Page, { name: "l6.r20" }),
            path("/l6/21", Page, { name: "l6.r21" }),
            path("/l6/22", Page, { name: "l6.r22" }),
            path("/l6/23", Page, { name: "l6.r23" }),
            path("/l6/24", Page, { name: "l6.r24" }),
            path("/l6/25", Page, { name: "l6.r25" }),
            path("/l6/26", Page, { name: "l6.r26" }),
            path("/l6/27", Page, { name: "l6.r27" }),
            path("/l6/28", Page, { name: "l6.r28" }),
            path("/l6/29", Page, { name: "l6.r29" }),
            path("/l6/30", Page, { name: "l6.r30" }),
            path("/l6/31", Page, { name: "l6.r31" }),
            path("/l6/32", Page, { name: "l6.r32" }),
            path("/l6/33", Page, { name: "l6.r33" }),
            path("/l6/34", Page, { name: "l6.r34" }),
            path("/l6/35", Page, { name: "l6.r35" }),
          ]),
        ]),
      ]),
    ]),
  ]),
]);

type Routes = NonNullable<(typeof stressTestPatterns)["_routes"]>;

// Test nested layout routes
type T1 = Routes["l1.r1"];
type T1_35 = Routes["l1.r35"];
type T6_35 = Routes["l6.r35"];
const _t1: T1 = "/l1/1";
const _t1_35: T1_35 = "/l1/35";
const _t6_35: T6_35 = "/l6/35";

// Test include at root level
type TInc0_1 = Routes["inc0.r1"];
type TInc0_300 = Routes["inc0.r300"];
const _inc0_1: TInc0_1 = "/inc0/r1";
const _inc0_300: TInc0_300 = "/inc0/r300";

// Test include at layout level 2
type TInc2_1 = Routes["inc2.r1"];
type TInc2_300 = Routes["inc2.r300"];
const _inc2_1: TInc2_1 = "/inc2/r1";
const _inc2_300: TInc2_300 = "/inc2/r300";

// Test include at layout level 5
type TInc5_1 = Routes["inc5.r1"];
type TInc5_300 = Routes["inc5.r300"];
const _inc5_1: TInc5_1 = "/inc5/r1";
const _inc5_300: TInc5_300 = "/inc5/r300";

// Verify no routes are lost
type IsNever<T> = [T] extends [never] ? "FAIL" : "PASS";
const _result: IsNever<keyof Routes> = "PASS";
type RouteKeys = keyof Routes;

export { stressTestPatterns };
