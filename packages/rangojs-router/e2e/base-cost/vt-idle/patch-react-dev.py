"""Instrument react-dom-client.development.js (investigation only, never committed).

usage: patch-react-dev.py <orig> <dest>
Every probe pushes onto window.__rlog: {k, t, ...}.
"""
import sys

src = open(sys.argv[1]).read()

HELPERS = r"""
    function __rl(k, o) {
      try {
        if ("undefined" === typeof window) return;
        var e = { k: k, t: performance.now() };
        if (o) for (var p in o) e[p] = o[p];
        (window.__rlog || (window.__rlog = [])).push(e);
      } catch (x) {}
    }
    function __fn(f) {
      try {
        if (!f) return null;
        var n = getComponentNameFromFiber(f);
        var s = n || "tag" + f.tag;
        if (13 === f.tag) s = "Suspense";
        if (22 === f.tag) s = "Offscreen" + (null !== f.memoizedState ? "(hidden)" : "");
        if (30 === f.tag) s = "ViewTransition";
        if (5 === f.tag) {
          s = "<" + f.type + ">";
          var tid = f.memoizedProps && f.memoizedProps["data-testid"];
          if (tid) s += "[" + tid + "]";
        }
        if (null != f.key) s += "#" + f.key;
        return s;
      } catch (x) {
        return "?";
      }
    }
    function __fp(f) {
      var out = [],
        n = f,
        i = 0;
      while (n && 12 > i) out.push(__fn(n)), (n = n.return), i++;
      return out.join(" < ");
    }
    function __wk(w) {
      try {
        if (!w) return null;
        if (!w.__rid) {
          window.__rwid = (window.__rwid || 0) + 1;
          Object.defineProperty(w, "__rid", { value: window.__rwid, enumerable: false });
        }
        var d = "w" + w.__rid + ":" + (w.status || "?");
        if (w.__tag) d += ":" + w.__tag;
        if (w.constructor && w.constructor.name && "Promise" !== w.constructor.name)
          d += ":" + w.constructor.name;
        return d;
      } catch (x) {
        return "?";
      }
    }
"""

count = 0


def rep(old, new, n=1):
    global src, count
    found = src.count(old)
    if found != n:
        raise SystemExit(f"anchor found {found} times (want {n}): {old[:90]!r}")
    src = src.replace(old, new)
    count += 1


# helpers at the top of the IIFE
rep(
    """  (function () {
    function findHook(fiber, id) {""",
    """  (function () {"""
    + HELPERS
    + """
    function findHook(fiber, id) {""",
)

# 1. every update scheduled
rep(
    """    function scheduleUpdateOnFiber(root, fiber, lane) {
""",
    """    function scheduleUpdateOnFiber(root, fiber, lane) {
      __rl("schedule", {
        lane: lane,
        fiber: __fp(fiber),
        cancelsPendingCommit: null !== root.cancelPendingCommit,
        hadTimeout: root.timeoutHandle !== noTimeout,
        stack: Error().stack
      });
""",
)

# 2. boundary retry (wakeable resolved after the fallback committed)
rep(
    """    function retryTimedOutBoundary(boundaryFiber, retryLane) {
      0 === retryLane && (retryLane = claimNextRetryLane());
""",
    """    function retryTimedOutBoundary(boundaryFiber, retryLane) {
      0 === retryLane && (retryLane = claimNextRetryLane());
      __rl("retry", { lane: retryLane, boundary: __fp(boundaryFiber) });
""",
)
rep(
    """    function resolveRetryWakeable(boundaryFiber, wakeable) {
      var retryLane = 0;
""",
    """    function resolveRetryWakeable(boundaryFiber, wakeable) {
      __rl("retry-wakeable", { wakeable: __wk(wakeable), boundary: __fp(boundaryFiber) });
      var retryLane = 0;
""",
)
rep(
    """          var retry = resolveRetryWakeable.bind(null, finishedWork, wakeable);
          wakeable.then(retry, retry);""",
    """          var retry = resolveRetryWakeable.bind(null, finishedWork, wakeable);
          __rl("attach-retry", { wakeable: __wk(wakeable), boundary: __fp(finishedWork) });
          wakeable.then(retry, retry);""",
)

# 3. ping of a suspended render
rep(
    """    function pingSuspendedRoot(root, wakeable, pingedLanes) {
      var pingCache = root.pingCache;
""",
    """    function pingSuspendedRoot(root, wakeable, pingedLanes) {
      __rl("ping", {
        lanes: pingedLanes,
        wakeable: __wk(wakeable),
        suspendedLanes: root.suspendedLanes,
        wipLanes: workInProgressRoot === root ? workInProgressRootRenderLanes : 0,
        hadTimeout: root.timeoutHandle !== noTimeout,
        hadPendingCommit: null !== root.cancelPendingCommit
      });
      var pingCache = root.pingCache;
""",
)
rep(
    """        (pingCache = pingSuspendedRoot.bind(null, root, wakeable, lanes)),""",
    """        __rl("attach-ping", { wakeable: __wk(wakeable), lanes: lanes, at: __fp(workInProgress) }),
        (pingCache = pingSuspendedRoot.bind(null, root, wakeable, lanes)),""",
)

# 4. render start / exit
rep(
    """    function performWorkOnRoot(root, lanes, forceSync) {
      if ((executionContext & (RenderContext | CommitContext)) !== NoContext)
        throw Error("Should not already be working.");
""",
    """    function performWorkOnRoot(root, lanes, forceSync) {
      if ((executionContext & (RenderContext | CommitContext)) !== NoContext)
        throw Error("Should not already be working.");
      __rl("render", { lanes: lanes, forceSync: forceSync, resumed: 0 !== workInProgressRootRenderLanes && null !== workInProgress });
""",
)
rep(
    """          a: {
            forceSync = root;
            switch (startTime) {
              case RootInProgress:""",
    """          a: {
            forceSync = root;
            __rl("render-exit", {
              lanes: lanes,
              status: ["InProgress", "FatalErrored", "Errored", "Suspended", "SuspendedWithDelay", "Completed", "SuspendedAtTheShell"][startTime]
            });
            switch (startTime) {
              case RootInProgress:""",
)

# 5. fallback throttle
rep(
    """                if (0 !== getNextLanes(forceSync, 0, !0)) break a;
                pendingEffectsLanes = lanes;
                forceSync.timeoutHandle = scheduleTimeout(""",
    """                if (0 !== getNextLanes(forceSync, 0, !0)) {
                  __rl("throttle-skipped-other-work", { lanes: lanes, ms: renderWasConcurrent });
                  break a;
                }
                __rl("throttle", { lanes: lanes, ms: renderWasConcurrent });
                pendingEffectsLanes = lanes;
                forceSync.timeoutHandle = scheduleTimeout(""",
)

# 6. commit gate (waits for the running view transition)
rep(
    """      root.timeoutHandle = noTimeout;
      var subtreeFlags = finishedWork.subtreeFlags,
        isViewTransitionEligible = (lanes & 335544064) === lanes,
        suspendedState = null;""",
    """      root.timeoutHandle = noTimeout;
      __rl("commit-ready-check", {
        lanes: lanes,
        eligible: (lanes & 335544064) === lanes,
        reason: suspendedCommitReason,
        exit: ["InProgress", "FatalErrored", "Errored", "Suspended", "SuspendedWithDelay", "Completed", "SuspendedAtTheShell"][exitStatus],
        runningVT: null != (9 === root.containerInfo.nodeType ? root.containerInfo : root.containerInfo.ownerDocument).__reactViewTransition
      });
      var subtreeFlags = finishedWork.subtreeFlags,
        isViewTransitionEligible = (lanes & 335544064) === lanes,
        suspendedState = null;""",
)
rep(
    """          pendingEffectsLanes = lanes;
          root.cancelPendingCommit = subtreeFlags(""",
    """          pendingEffectsLanes = lanes;
          __rl("commit-suspended", {
            lanes: lanes,
            waitingForViewTransition: suspendedState.waitingForViewTransition,
            count: suspendedState.count
          });
          root.cancelPendingCommit = subtreeFlags(""",
)

# 7. commit, and whether it starts a view transition
rep(
    """      pendingEffectsStatus = PENDING_MUTATION_PHASE;
      shouldStartViewTransition
        ? ((animatingLanes |= lanes),""",
    """      pendingEffectsStatus = PENDING_MUTATION_PHASE;
      __rl("commit", {
        lanes: lanes,
        eligible: (lanes & 335544064) === lanes,
        startsViewTransition: shouldStartViewTransition,
        types: pendingTransitionTypes
      });
      shouldStartViewTransition
        ? ((animatingLanes |= lanes),""",
)

# 8. what flagged the commit as a view transition
rep(
    """      if (30 === placement.tag || 0 !== (placement.subtreeFlags & 33554432))
        shouldStartViewTransition = !0;""",
    """      if (30 === placement.tag || 0 !== (placement.subtreeFlags & 33554432))
        __rl("vt-flag", { why: "enter", fiber: __fp(placement) }),
          (shouldStartViewTransition = !0);""",
)
rep(
    """          shouldStartViewTransition = !0;
          applyViewTransitionName(""",
    """          __rl("vt-flag", { why: "apply-name", name: name, className: className, host: __fp(child) });
          shouldStartViewTransition = !0;
          applyViewTransitionName(""",
)
# before-mutation: an existing <ViewTransition> on the traversal path is named for "update"
rep(
    """              "none" !== current &&
                applyViewTransitionToHostInstances(
                  isViewTransitionEligible,
                  finishedWork,
                  current,
                  (isViewTransitionEligible.memoizedState = []),
                  !0
                ));""",
    """              __rl("vt-before-update", { vt: __fp(fiber), className: current, flags: fiber.flags, subtreeFlags: fiber.subtreeFlags }),
              "none" !== current &&
                applyViewTransitionToHostInstances(
                  isViewTransitionEligible,
                  finishedWork,
                  current,
                  (isViewTransitionEligible.memoizedState = []),
                  !0
                ));""",
)

# 9. mutation phase: host mutation inside the boundary marks it updated
rep(
    """          _eventPayloads$ii2 &&
            null !== current &&
            viewTransitionMutationContext &&
            (finishedWork.flags |= 4);""",
    """          __rl("vt-mutation", {
            vt: __fp(finishedWork),
            eligible: _eventPayloads$ii2,
            isUpdate: null !== current,
            hostMutationInside: viewTransitionMutationContext
          });
          _eventPayloads$ii2 &&
            null !== current &&
            viewTransitionMutationContext &&
            (finishedWork.flags |= 4);""",
)
# host insertions (to name what was inserted)
rep(
    """          before ? parent.insertBefore(tag, before) : parent.appendChild(tag),
          commitNewChildToFragmentInstances(node, parentFragmentInstances),
          (viewTransitionMutationContext = !0);""",
    """          before ? parent.insertBefore(tag, before) : parent.appendChild(tag),
          __rl("host-insert", { node: __fp(node), hiddenSubtree: offscreenSubtreeIsHidden }),
          commitNewChildToFragmentInstances(node, parentFragmentInstances),
          (viewTransitionMutationContext = !0);""",
)

# 10. after mutation: does the boundary animate or get cancelled
rep(
    """            0 !== (finishedWork.flags & 4) && root
              ? (scheduleViewTransitionEvent(
                  finishedWork,
                  finishedWork.memoizedProps.onUpdate
                ),""",
    """            __rl("vt-after-update", {
              vt: __fp(finishedWork),
              className: className,
              updateFlag: 0 !== (finishedWork.flags & 4),
              inViewport: root,
              animates: 0 !== (finishedWork.flags & 4) && !!root
            });
            0 !== (finishedWork.flags & 4) && root
              ? (scheduleViewTransitionEvent(
                  finishedWork,
                  finishedWork.memoizedProps.onUpdate
                ),""",
)
rep(
    """            if (!viewTransitionContextChanged && !rootViewTransitionAffected) {
              finishedWork = viewTransitionCancelableChildren;""",
    """            __rl("vt-root", { cancelsAll: !viewTransitionContextChanged && !rootViewTransitionAffected });
            if (!viewTransitionContextChanged && !rootViewTransitionAffected) {
              finishedWork = viewTransitionCancelableChildren;""",
)

# 11. fallback (dis)appearance commit: the throttle clock
rep(
    """            (null !== finishedWork.memoizedState) !==
              (null !== current && null !== current.memoizedState) &&
            (globalMostRecentFallbackTime = now$1());""",
    """            (null !== finishedWork.memoizedState) !==
              (null !== current && null !== current.memoizedState) &&
            (__rl("fallback-toggle", { boundary: __fp(finishedWork), showsFallback: null !== finishedWork.memoizedState }),
            (globalMostRecentFallbackTime = now$1()));""",
)

# 12. host startViewTransition
rep(
    """      try {
        var transition = ownerDocument.startViewTransition({
          update: function () {""",
    """      try {
        __rl("startViewTransition", { types: transitionTypes });
        var transition = ownerDocument.startViewTransition({
          update: function () {""",
)

open(sys.argv[2], "w").write(src)
print(f"applied {count} probes")
