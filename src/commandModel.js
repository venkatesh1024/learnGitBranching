var Command = Backbone.Model.extend({
  defaults: {
    status: 'inqueue',
    result: '',
    error: null,
    generalArgs: [],
    supportedMap: {},
    options: null,
    method: null,
    createTime: null,
    rawStr: null
  },

  validateAtInit: function() {
    if (!this.get('rawStr')) {
      throw new Error('Give me a string!');
    }
    if (!this.get('createTime')) {
      this.set('createTime', new Date().toString());
    }
    this.on('change:error', this.errorChanged, this);
  },

  initialize: function() {
    this.validateAtInit();
    this.parseOrCatch();
  },

  parseOrCatch: function() {
    try {
      this.parse();
    } catch (err) {
      if (err instanceof CommandProcessError ||
          err instanceof GitError) {
        this.set('status', 'error');
        this.set('error', err);
      } else if (err instanceof CommandResult) {
        this.set('status', 'finished');
        this.set('error', err);
      } else {
        throw err;
      }
    }
  },

  errorChanged: function(model, err) {
    this.set('err', err);
    this.set('status', 'error');
    this.formatError();
  },

  formatError: function() {
    this.set('result', this.get('err').toResult());
  },

  getShortcutMap: function() {
    return {
      'git commit': /^gc($|\s)/,
      'git add': /^ga($|\s)/,
      'git checkout': /^gchk($|\s)/,
      'git rebase': /^gr($|\s)/,
      'git branch': /^gb($|\s)/
    };
  },

  getRegexMap: function() {
    return {
      // ($|\s) means that we either have to end the string
      // after the command or there needs to be a space for options
      commit: /^commit($|\s)/,
      add: /^add($|\s)/,
      checkout: /^checkout($|\s)/,
      rebase: /^rebase($|\s)/,
      reset: /^reset($|\s)/,
      branch: /^branch($|\s)/,
      revert: /^revert($|\s)/,
      merge: /^merge($|\s)/
    };
  },

  getSandboxCommands: function() {
    return [
      [/^ls/, function() {
        throw new CommandResult({
          msg: "DontWorryAboutFilesInThisDemo.txt"
        });
      }],
      [/^cd/, function() {
        throw new CommandResult({
          msg: "Directory Changed to '/directories/dont/matter/in/this/demo'"
        });
      }],
      [/^git$/, function() {
        // TODO better git description. also help, hint, etc
        throw new CommandResult({
          msg: _.escape("\
            Git Version \n \
            PCOTTLE.1.0 \
            Usage: \n \
              git <command> [<args>] \
          ")
        });
      }],
      [/^refresh$/, function() {
        events.trigger('refreshTree');
        throw new CommandResult({
          msg: "Refreshing tree..."
        });
      }]
    ];
  },

  parse: function() {
    var str = this.get('rawStr');
    // first if the string is empty, they just want a blank line
    if (!str.length) {
      throw new CommandResult({msg: ""});
    }

    // then check if it's one of our sandbox commands
    _.each(this.getSandboxCommands(), function(tuple) {
      var regex = tuple[0];
      if (regex.exec(str)) {
        tuple[1]();
      }
    });

    // then check if shortcut exists, and replace, but
    // preserve options if so
    _.each(this.getShortcutMap(), function(regex, method) {
      var results = regex.exec(str);
      if (results) {
        str = method + ' ' + str.slice(results[0].length);
      }
    });

    // see if begins with git
    if (str.slice(0,3) !== 'git') {
      throw new CommandProcessError({
        msg: 'Git commands only, sorry!'
      });
    }

    // ok, we have a (probably) valid command. actually parse it
    this.gitParse(str);
  },

  gitParse: function(str) {
    // now slice off command part
    var fullCommand = str.slice('git '.length);

    // see if we support this particular command
    _.each(this.getRegexMap(), function(regex, method) {
      if (regex.exec(fullCommand)) {
        this.set('options', fullCommand.slice(method.length + 1));
        this.set('method', method);
        // we should stop iterating, but the regex will only match
        // one command in practice. we could stop iterating if we used
        // jqeurys for each but im using underscore (for no real reason other
        // than style)
      }
    }, this);

    if (!this.get('method')) {
      throw new CommandProcessError({
        msg: "Sorry, this demo does not support that git command: " + fullCommand
      });
    }

    // parse off the options and assemble the map / general args
    var optionParser = new OptionParser(this.get('method'), this.get('options'));

    // steal these away so we can be completely JSON
    this.set('generalArgs', optionParser.generalArgs);
    this.set('supportedMap', optionParser.supportedMap);
  },
});

/**
 * OptionParser
 */
function OptionParser(method, options) {
  this.method = method;
  this.rawOptions = options;

  this.supportedMap = this.getMasterOptionMap()[method];
  if (this.supportedMap === undefined) {
    throw new Error('No option map for ' + method);
  }

  this.generalArgs = [];
  this.explodeAndSet();
}

OptionParser.prototype.getMasterOptionMap = function() {
  // here a value of false means that we support it, even if its just a
  // pass-through option. If the value is not here (aka will be undefined
  // when accessed), we do not support it.
  return {
    commit: {
      '--amend': false,
      '-a': false, // warning
      '-am': false
    },
    add: {},
    branch: {
      '-d': false,
      '-D': false
    },
    checkout: {
      '-b': false
    },
    reset: {
      '--hard': false,
      '--soft': false, // this will raise an error but we catch it in gitEngine
    },
    merge: {},
    rebase: {},
    revert: {}
  };
};

OptionParser.prototype.explodeAndSet = function() {
  // split on spaces, except when inside quotes, and strip quotes after.
  // for some reason the regex includes the quotes even if i move the parantheses
  // inside
  var exploded = this.rawOptions.match(/('.*?'|".*?"|\S+)/g) || [];
  _.each(exploded, function(part, i) {
    exploded[i] = part.replace(/['"]/g, '');
  });

  for (var i = 0; i < exploded.length; i++) {
    var part = exploded[i];
    if (part.slice(0,1) == '-') {
      // it's an option, check supportedMap
      if (this.supportedMap[part] === undefined) {
        throw new CommandProcessError({
          msg: 'The option "' + part + '" is not supported'
        });
      }

      // go through and include all the next args until we hit another option or the end
      var optionArgs = [];
      var next = i + 1;
      while (next < exploded.length && exploded[next].slice(0,1) != '-') {
        optionArgs.push(exploded[next]);
        next += 1;
      }
      i = next - 1;

      // **phew** we are done grabbing those. theseArgs is truthy even with an empty array
      this.supportedMap[part] = optionArgs;
    } else {
      // must be a general arg
      this.generalArgs.push(part);
    }
  }

  // done!
};
