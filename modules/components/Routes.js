var React = require('react');
var warning = require('react/lib/warning');
var copyProperties = require('react/lib/copyProperties');
var canUseDOM = require('react/lib/ExecutionEnvironment').canUseDOM;
var Promise = require('when/lib/Promise');
var LocationActions = require('../actions/LocationActions');
var Route = require('../components/Route');
var ActiveDelegate = require('../mixins/ActiveDelegate');
var PathListener = require('../mixins/PathListener');
var RouteStore = require('../stores/RouteStore');
var Path = require('../utils/Path');
var Redirect = require('../utils/Redirect');
var Transition = require('../utils/Transition');

/**
 * The ref name that can be used to reference the active route component.
 */
var REF_NAME = '__activeRoute__';

/**
 * The default handler for aborted transitions. Redirects replace
 * the current URL and all others roll it back.
 */
function defaultAbortedTransitionHandler(transition) {
  if (!canUseDOM)
    return;

  var reason = transition.abortReason;

  if (reason instanceof Redirect) {
    LocationActions.replaceWith(reason.to, reason.params, reason.query);
  } else {
    LocationActions.goBack();
  }
}

/**
 * The default handler for errors that were thrown asynchronously
 * while transitioning. The default behavior is to re-throw the
 * error so that it isn't silently swallowed.
 */
function defaultTransitionErrorHandler(error) {
  setTimeout(function () { // Use setTimeout to break the promise chain.
    throw error; // This error probably originated in a transition hook.
  });
}

function maybeUpdateScroll(routes) {
  if (!canUseDOM)
    return;

  var currentRoute = routes.getCurrentRoute();

  if (!routes.props.preserveScrollPosition && currentRoute && !currentRoute.props.preserveScrollPosition)
    LocationActions.updateScroll();
}

/**
 * The <Routes> component configures the route hierarchy and renders the
 * route matching the current location when rendered into a document.
 *
 * See the <Route> component for more details.
 */
var Routes = React.createClass({

  displayName: 'Routes',

  mixins: [ ActiveDelegate, PathListener ],

  propTypes: {
    onAbortedTransition: React.PropTypes.func.isRequired,
    onTransitionError: React.PropTypes.func.isRequired,
    preserveScrollPosition: React.PropTypes.bool.isRequired
  },

  getDefaultProps: function () {
    return {
      onAbortedTransition: defaultAbortedTransitionHandler,
      onTransitionError: defaultTransitionErrorHandler,
      preserveScrollPosition: false
    };
  },

  getInitialState: function () {
    return {
      routes: RouteStore.registerChildren(this.props.children, this)
    };
  },

  /**
   * Gets the <Route> component that is currently active.
   */
  getCurrentRoute: function () {
    var rootMatch = getRootMatch(this.state.matches);
    return rootMatch && rootMatch.route;
  },

  /**
   * Performs a depth-first search for the first route in the tree that matches
   * on the given path. Returns an array of all routes in the tree leading to
   * the one that matched in the format { route, params } where params is an
   * object that contains the URL parameters relevant to that route. Returns
   * null if no route in the tree matches the path.
   *
   *   React.renderComponent(
   *     <Routes>
   *       <Route handler={App}>
   *         <Route name="posts" handler={Posts}/>
   *         <Route name="post" path="/posts/:id" handler={Post}/>
   *       </Route>
   *     </Routes>
   *   ).match('/posts/123'); => [ { route: <AppRoute>, params: {} },
   *                               { route: <PostRoute>, params: { id: '123' } } ]
   */
  match: function (path) {
    return findMatches(Path.withoutQuery(path), this.state.routes, this.props.defaultRoute, this.props.notFoundRoute);
  },

  /**
   * Performs a transition to the given path and returns a promise for the
   * Transition object that was used.
   *
   * In order to do this, the router first determines which routes are involved
   * in the transition beginning with the current route, up the route tree to
   * the first parent route that is shared with the destination route, and back
   * down the tree to the destination route. The willTransitionFrom static
   * method is invoked on all route handlers we're transitioning away from, in
   * reverse nesting order. Likewise, the willTransitionTo static method
   * is invoked on all route handlers we're transitioning to.
   *
   * Both willTransitionFrom and willTransitionTo hooks may either abort or
   * redirect the transition. If they need to resolve asynchronously, they may
   * return a promise.
   *
   * Note: This function does not update the URL in a browser's location bar.
   * If you want to keep the URL in sync with transitions, use Router.transitionTo,
   * Router.replaceWith, or Router.goBack instead.
   */
  updatePath: function (path) {
    var transition = new Transition(path);

    return syncWithTransition(this, transition).then(
      function () {
        if (transition.isAborted) {
          this.props.onAbortedTransition(transition);
        } else {
          maybeUpdateScroll(this);
        }

        return transition;
      }.bind(this)
    ).then(
      undefined, this.props.onTransitionError
    );
  },

  render: function () {
    var matches = this.state.matches;

    if (!matches || !matches.length)
      return null;

    var firstMatch = matches[0];

    if (!firstMatch.shouldRender)
      return null;

    return matches[0].route.props.handler(
      computeHandlerProps(matches, this.state.activeQuery)
    );
  }

});

function findMatches(path, routes, defaultRoute, notFoundRoute) {
  var matches = null, route, params;

  for (var i = 0, len = routes.length; i < len; ++i) {
    route = routes[i];

    // Check the subtree first to find the most deeply-nested match.
    matches = findMatches(path, route.props.children, route.props.defaultRoute, route.props.notFoundRoute);

    if (matches != null) {
      var rootParams = getRootMatch(matches).params;
      
      params = route.props.paramNames.reduce(function (params, paramName) {
        params[paramName] = rootParams[paramName];
        return params;
      }, {});

      matches.unshift(makeMatch(route, params));

      return matches;
    }

    // No routes in the subtree matched, so check this route.
    params = Path.extractParams(route.props.path, path);

    if (params)
      return [ makeMatch(route, params) ];
  }

  // No routes matched, so try the default route if there is one.
  if (defaultRoute && (params = Path.extractParams(defaultRoute.props.path, path)))
    return [ makeMatch(defaultRoute, params) ];

  // Last attempt: does the "not found" route match?
  if (notFoundRoute && (params = Path.extractParams(notFoundRoute.props.path, path)))
    return [ makeMatch(notFoundRoute, params) ];

  return matches;
}

function makeMatch(route, params) {
  return { route: route, params: params };
}

function hasMatch(matches, match) {
  return matches.some(function (m) {
    if (m.route !== match.route)
      return false;

    for (var property in m.params) {
      if (m.params[property] !== match.params[property])
        return false;
    }

    return true;
  });
}

function getRootMatch(matches) {
  return matches[matches.length - 1];
}

function updateMatchComponents(matches, refs) {
  var i = 0, component;
  while (component = refs[REF_NAME]) {
    matches[i++].component = component;
    refs = component.refs;
  }
}

/**
 * Runs all willTransition* hooks, computes and sets new state for routes,
 * and returns a promise that resolves after all didTransition* hooks run.
 */
function syncWithTransition(component, transition) {
  if (component.state.path === transition.path)
    return Promise.resolve(); // Nothing to do!

  var currentMatches = component.state.matches;
  var nextMatches = component.match(transition.path);

  warning(
    nextMatches,
    'No route matches path "' + transition.path + '". Make sure you have ' +
    '<Route path="' + transition.path + '"> somewhere in your routes'
  );

  if (!nextMatches)
    nextMatches = [];

  var fromMatches, toMatches;
  if (currentMatches) {
    updateMatchComponents(currentMatches, component.refs);

    fromMatches = currentMatches.filter(function (match) {
      return !hasMatch(nextMatches, match);
    });

    toMatches = nextMatches.filter(function (match) {
      return !hasMatch(currentMatches, match);
    });
  } else {
    fromMatches = [];
    toMatches = nextMatches;
  }

  var query = Path.extractQuery(transition.path) || {};

  try {
    runWillTransitionFromHooks(fromMatches, transition);
  } catch (error) {
    return Promise.reject(error);
  }

  if (transition.isAborted)
    return; // No need to continue.

  return runWillTransitionToHooks(toMatches, transition, query).then(function () {
    if (transition.isAborted || !component.isMounted())
      return; // No need to continue.

    return new Promise(function (resolve, reject) {
      var rootMatch = getRootMatch(nextMatches);
      var params = (rootMatch && rootMatch.params) || {};
      var routes = nextMatches.map(function (match) {
        return match.route;
      });

      runDidTransitionFromHooks(fromMatches);
      runDidTransitionToHooks(toMatches, query, component);

      if (currentMatches) {
        currentMatches.forEach(function (match) {
          match.isStale = true;
        });
      }

      component.setState({
        path: transition.path,
        matches: nextMatches,
        activeRoutes: routes,
        activeParams: params,
        activeQuery: query
      }, function () {
        try {
          component.emitChange();
          resolve();
        } catch (error) {
          reject(error);
        }
      })
    });
  });
}

/**
 * Runs the willTransitionFrom hook of all handlers serially in reverse.
 */
function runWillTransitionFromHooks(matches, transition) {
  reversedArray(matches).forEach(function (match) {
    var handler = match.route.props.handler;

    if (!transition.isAborted && handler.willTransitionFrom)
      handler.willTransitionFrom(transition, match.component);
  });
}

/**
 * Runs the willTransitionTo hook of all handlers serially and returns
 * a promise that resolves after the last handler is finished.
 */
function runWillTransitionToHooks(matches, transition, query) {
  var promise = Promise.resolve();

  matches.forEach(function (match) {
    promise = promise.then(function () {
      var handler = match.route.props.handler;

      if (!transition.isAborted && handler.willTransitionTo)
        return handler.willTransitionTo(transition, match.params, query);
    });
  });

  return promise;
}

/**
 * Runs the didTransitionFrom hook of all handlers serially in reverse.
 */
function runDidTransitionFromHooks(matches) {
  reversedArray(matches).forEach(function (match) {
    var handler = match.route.props.handler;

    if (handler.didTransitionFrom)
      handler.didTransitionFrom();
  });
}

/**
 * Runs the didTransitionTo hook of all handlers serially.
 */
function runDidTransitionToHooks(matches, query, component) {
  matches.forEach(function (match) {
    var handler = match.route.props.handler;

    match.props = {};

    function setProps(newProps, callback) {
      if (match.isStale) {
        warning(
          !component.isMounted(),
          'setProps called from %s.didTransitionTo after transitioning away. Be sure ' +
          'to clean up all data subscribers in didTransitionFrom',
          handler.displayName || 'UnnamedRouteHandler'
        );
      } else {
        copyProperties(match.props, newProps);

        if (handler.shouldHandlerRender)
          match.shouldRender = !!handler.shouldHandlerRender(match.props);

        if (component.isMounted())
          component.forceUpdate(callback);
      }
    }

    if (handler.didTransitionTo)
      handler.didTransitionTo(match.params, query, setProps);

    // Manually call handler.shouldHandlerRender if
    // handler.didTransitionTo doesn't immediately setProps.
    if (match.shouldRender == null)
      match.shouldRender = handler.shouldHandlerRender ? !!handler.shouldHandlerRender(match.props) : true;
  });
}

/**
 * Given an array of matches as returned by findMatches, return a descriptor for
 * the handler hierarchy specified by the route.
 */
function computeHandlerProps(matches, query) {
  var childHandler = returnNull;
  var props = {
    ref: null,
    key: null,
    params: null,
    query: null,
    activeRouteHandler: childHandler
  };

  reversedArray(matches).forEach(function (match) {
    var route = match.route;

    props = Route.getUnreservedProps(route.props);

    if (match.props)
      copyProperties(props, match.props);

    if (route.props.addHandlerKey)
      props.key = Path.injectParams(route.props.path, match.params);

    props.ref = REF_NAME;
    props.params = match.params;
    props.query = query;
    props.activeRouteHandler = childHandler;

    if (match.shouldRender) {
      childHandler = function (props, addedProps) {
        if (arguments.length > 2 && typeof arguments[2] !== 'undefined')
          throw new Error('Passing children to a route handler is not supported');

        return route.props.handler(copyProperties(props, addedProps));
      }.bind(this, props);
    } else {
      childHandler = returnNull;
    }
  });

  return props;
}

function returnNull() {
  return null;
}

function reversedArray(array) {
  return array.slice(0).reverse();
}

module.exports = Routes;
