'use strict'

/**********************************************************************
 * Our high-level automation language
 **********************************************************************/

var StatementTypes = {
  MOUSE: 1,
  KEYBOARD: 2,
  LOAD: 3,
  SCRAPE: 4,
  SCRAPELINK: 5,
  KEYUP: 6,
  PULLDOWNINTERACTION: 7
};

// make this call early so that the voices will be loaded early
speechSynthesis.getVoices(); // in case we ever want to say anything

// these are outside because they're useful for controling the tool via selenium and so on
// but should really be hidden soon.  todo: hide them
var scrapingRunsCompleted = 0;
var datasetsScraped = [];
var currentRunObjects = [];
var recordingWindowIds = [];
var currentReplayWindowId = null;

var demoMode = false;

function shortPrintString(obj){
  if (!obj){
    return JSON.stringify(obj);
  }
  else{
    return JSON.stringify(obj).substring(0,20);
  }
}

utilities.listenForMessage("content", "mainpanel", "currentReplayWindowId", 
  function(){utilities.sendMessage("mainpanel", "content", "currentReplayWindowId", {window: currentReplayWindowId});});

var WebAutomationLanguage = (function _WebAutomationLanguage() {
  var pub = {};
  var UIObject = null;

  pub.blocklyLabels = {"text": [], "numbers": [], "other":[]};

  /* some of the things we do within the objects that represent the programs, statements,
  and expressions should update the UI object that's serving as the IDE.  the UI
  object should implement all of these functions, or whatever subset of them the user
  will be able to trigger by using the Helena language as the interface allows:
  UIObject.updateDisplayedScript(bool updateBlockly)
  UIObject.updateDisplayedRelations(bool stillInProgress)
  UIObject.addNewRowToOutput(str idOfProgramRunTab, array displayTextCells)
  UIObject.updateRowsSoFar(str idOfProgramRunTab, int fullDatasetLength)
  UIObject.addDialog(str title, str dialogText, dict buttonTextToHandlers)
  UIObject.showRelationEditor(Relation rel, int chromeTabId)
  UIObject.continueAfterDialogue(str text, str buttonText, cont continuation)
  Tab tab = UIObject.newRunTab(RunObject ro)
  */

  pub.setUIObject = function _setUIObject(obj){
    if (obj){
      UIObject = obj;
      Environment.setUIObject(obj);
    }
  };

  pub.resetForNewScript = function _resetForNewScript(){
    // if the user is going to be starting a fresh script, it shouldn't be allowed to use variables from
    // a past script or scripts
    allNodeVariablesSeenSoFar = [];
  }

  var toolId = null; // it's ok to just run with this unless you want to only load programs associated with your own helena-using tool
  pub.setHelenaToolId = function _setHelenaToolId(tid){
    toolId = tid;
    console.log("Setting toolId", toolId);
  };
  pub.getHelenaToolId = function _getHelenaToolId(){
    return toolId;
  };

  var statementToEventMapping = {
    mouse: ['click','dblclick','mousedown','mousemove','mouseout','mouseover','mouseup'],
    keyboard: ['keydown','keyup','keypress','textinput','paste','input'],
    dontcare: ['blur']
  };

  // helper function.  returns the StatementType (see above) that we should associate with the argument event, or null if the event is invisible
  pub.statementType = function _statementType(ev){
    if (ev.type === "completed" || ev.type === "manualload" || ev.type === "webnavigation"){
      if (!EventM.getVisible(ev)){
        return null; // invisible, so we don't care where this goes
      }
      return StatementTypes.LOAD;
    }
    else if (ev.type === "dom"){
      if (statementToEventMapping.dontcare.indexOf(ev.data.type) > -1){
        return null; // who cares where blur events go
      }
      var lowerXPath = ev.target.xpath.toLowerCase();
      if (lowerXPath.indexOf("/select[") > -1){
        // this was some kind of interaction with a pulldown, so we have something special for this
        return StatementTypes.PULLDOWNINTERACTION;
      }
      else if (statementToEventMapping.mouse.indexOf(ev.data.type) > -1){
        if (ev.additional.scrape){
          if (ev.additional.scrape.linkScraping){
            return StatementTypes.SCRAPELINK;
          }
          return StatementTypes.SCRAPE;
        }
        return StatementTypes.MOUSE;
      }
      else if (statementToEventMapping.keyboard.indexOf(ev.data.type) > -1){
        /*
        if (ev.data.type === "keyup"){
          return StatementTypes.KEYUP;
        }
        */
        //if ([16, 17, 18].indexOf(ev.data.keyCode) > -1){
        //  // this is just shift, ctrl, or alt key.  don't need to show these to the user
        //  return null;
        //}
        return StatementTypes.KEYBOARD;
      }
    }
    return null; // these events don't matter to the user, so we don't care where this goes
  }

  function firstVisibleEvent(trace){
    for (var i = 0; i < trace.length; i++){
      var ev = trace[i];
      var st = WebAutomationLanguage.statementType(ev);
      if (st !== null){
        return ev;
      }
    }
  }

  // helper functions that some statements will use

  function makePageVarsDropdown(pageVars){
    var pageVarsDropDown = [];
    for (var i = 0; i < pageVars.length; i++){
      var pageVarStr = pageVars[i].toString();
      pageVarsDropDown.push([pageVarStr, pageVarStr]);
    }
    return pageVarsDropDown;
  }

  function makeRelationsDropdown(relations){
    var relationsDropDown = [];
    for (var i = 0; i < relations.length; i++){
      var relationStr = relations[i].name;
      relationsDropDown.push([relationStr, relationStr]);
    }
    return relationsDropDown;
  }

  function makeVariableNamesDropdown(prog){
    var varNames = prog.getAllVariableNames();
    var varNamesDropDown = [];
    for (var i = 0; i < varNames.length; i++){
      varNamesDropDown.push([varNames[i], varNames[i]]);
    }
    return varNamesDropDown;
  }

  function makeOpsDropdown(ops){
    var opsDropdown = [];
    for (var key in ops){
      opsDropdown.push([key, key]);
    }
    return opsDropdown;
  }

  function nodeRepresentation(statement, linkScraping){
    if (linkScraping === undefined){ linkScraping = false; }
    if (statement.currentNode instanceof WebAutomationLanguage.NodeVariable){
      var alreadyBound = statement.currentNode.getSource() === NodeSources.RELATIONEXTRACTOR; // todo: this isn't really correct.  we could reuse a node scraped or clicked before, and then it would be bound already.  fix this.
      var nodeRep = statement.currentNode.toString(alreadyBound, statement.pageVar);
      if (linkScraping){
        nodeRep += ".link";
      }
      return nodeRep;
    }
    if (statement.trace[0].additional.visualization === "whole page"){
      return "whole page";
    }
    if (linkScraping){
      return statement.trace[0].additional.scrape.link; // we don't have a better way to visualize links than just giving text
    }
    return "<img src='"+statement.trace[0].additional.visualization+"' style='max-height: 150px; max-width: 350px;'>";
  }

  function makeNodeVariableForTrace(trace){
    var recordTimeNode = null;
    var recordTimeNodeSnapshot = null;
    var imgData = null;
    if (trace.length > 0){ // may get 0-length trace if we're just adding a scrape statement by editing (as for a known column in a relation)
      var ev = trace[0]; // 0 bc this is the first ev that prompted us to turn it into the given statement, so must use the right node
      recordTimeNodeSnapshot = ev.target.snapshot;
      imgData = ev.additional.visualization;
    }
    return new WebAutomationLanguage.NodeVariable(null, null, recordTimeNodeSnapshot, imgData, NodeSources.RINGER); // null bc no preferred name
  }

  function urlMatchSymmetryHelper(t1, t2){
    // todo: there might be other ways that we could match the url.  don't need to match the whole thing
    // don't need www, etc, any lingering bits on the end that get added...

    if (t1.replace("http://", "https://") === t2){
      return true;
    }
    return false;
  }
  function urlMatch(text, currentUrl){
    return urlMatchSymmetryHelper(text, currentUrl) || urlMatchSymmetryHelper(currentUrl, text);
  }

  function outputPagesRepresentation(statement){
    var prefix = "";
    if (statement.outputPageVars.length > 0){
      prefix = _.map(statement.outputPageVars, function(pv){return pv.toString();}).join(", ")+" = ";
    }
    return prefix;
  }

  // returns true if we successfully parameterize this node with this relation, false if we can't
  function parameterizeNodeWithRelation(statement, relation, pageVar){
      // note: may be tempting to use the columns' xpath attributes to decide this, but this is not ok!  now that we can have
      // mutliple suffixes associated with a column, that xpath is not always correct
      // but we're in luck because we know the selector has just been applied to the relevant page (to produce relation.demonstrationTimeRelation and from that relation.firstRowXpaths)
      // so we can learn from those attributes which xpaths are relevant right now, and thus which ones the user would have produced in the current demo
      
      // if the relation is a text relation, we actually don't want to do the below, because it doesn't represent nodes, only texts
      if (relation instanceof WebAutomationLanguage.TextRelation){
        return null;
      }

      // hey, this better be in the same order as relation.columns and relation.firstRowXpaths!
      // todo: maybe add some helper functions to get rid of this necessity? since it may not be clear in there...
      var nodeRepresentations = relation.firstRowNodeRepresentations();

      for (var i = 0; i < relation.firstRowXPaths.length; i++){
        var firstRowXpath = relation.firstRowXPaths[i];
        if (firstRowXpath === statement.origNode || 
            (statement instanceof WebAutomationLanguage.PulldownInteractionStatement && firstRowXpath.indexOf(statement.origNode) > -1)){
          statement.relation = relation;
          var name = relation.columns[i].name;
          var nodeRep = nodeRepresentations[i];

          // not ok to just overwrite currentNode, because there may be multiple statements using the old
          // currentNode, and becuase we're interested in keeping naming consistent, they should keep using it
          // so...just overwrite some things
          if (!statement.currentNode){
            // have to check if there's a current node because if we're dealing with pulldown menu there won't be
            statement.currentNode = new WebAutomationLanguage.NodeVariable();
          }
          statement.currentNode.setName(name);
          statement.currentNode.nodeRep = nodeRep;
          statement.currentNode.setSource(NodeSources.RELATIONEXTRACTOR);
          // statement.currentNode = new WebAutomationLanguage.NodeVariable(name, nodeRep, null, null, NodeSources.RELATIONEXTRACTOR); // note that this means the elements in the firstRowXPaths and the elements in columns must be aligned!
          // ps. in theory the above commented out line should have just worked
          // because we could search all prior nodes to see if any is the same
          // but we just extracted the relation from a fresh run of the script, so any of the attributes we use
          // (xpath, text, or even in some cases url) could have changed, and we'd try to make a new node, and mess it up
          // since we know we want to treat this as the same as a prior one, better to just do this

          // the statement should track whether it's currently parameterized for a given relation and column obj
          statement.relation = relation;
          statement.columnObj = relation.columns[i];

          return relation.columns[i]; 
        }
      }
      return null;
  }

  function unParameterizeNodeWithRelation(statement, relation){
    if (statement.relation === relation){
      statement.relation = null;
      statement.columnObj = null;
      var columnObject = statement.columnObj;
      statement.columnObj = null;
      statement.currentNode = makeNodeVariableForTrace(statement.trace);
      return columnObject;
    }
    return null;
  }

  function currentNodeXpath(statement, environment){
    if (statement.currentNode instanceof WebAutomationLanguage.NodeVariable){
      return statement.currentNode.currentXPath(environment);
    }
    return statement.currentNode; // this means currentNode better be an xpath if it's not a variable use!
  }

  function currentTab(statement){
    return statement.pageVar.currentTabId();
  }

  function originalTab(statement){
    return statement.pageVar.originalTabId();
  }

  function cleanTrace(trace){
    var cleanTrace = [];
    for (var i = 0; i < trace.length; i++){
      cleanTrace.push(cleanEvent(trace[i]));
    }
    return cleanTrace;
  }

  function cleanEvent(ev){
      var displayData = EventM.getDisplayInfo(ev);
      EventM.clearDisplayInfo(ev);
      var cleanEvent = clone(ev);
      // now restore the true trace object
      EventM.setDisplayInfo(ev, displayData);
      return cleanEvent;
  }

  function proposeCtrlAdditions(statement){
    if (statement.outputPageVars.length > 0){
      var counter = 0;
      var lastIndex = _.reduce(statement.trace, function(acc, ev){counter += 1; if (EventM.getDOMOutputLoadEvents(ev).length > 0) {return counter;} else {return acc;}}, 0);

      var ctrlKeyDataFeatures = {altKey: false, bubbles: true, cancelable: true, charCode: 0, ctrlKey: true, keyCode: 17, keyIdentifier: "U+00A2", keyLocation: 1, metaKey: false, shiftKey: false, timeStamp: 1466118461375, type: "keydown"};

      var ctrlDown = cleanEvent(statement.trace[0]); // clones
      ctrlDown.data = ctrlKeyDataFeatures;
      ctrlDown.meta.dispatchType = "KeyboardEvent";

      var ctrlUp = cleanEvent(statement.trace[0]);
      ctrlUp.data = clone(ctrlKeyDataFeatures);
      ctrlUp.data.ctrlKey = false;
      ctrlUp.data.type = "keyup";
      ctrlUp.meta.dispatchType = "KeyboardEvent";

      statement.trace.splice(lastIndex, 0, ctrlUp);
      statement.trace.splice(0, 0, ctrlDown);

      WALconsole.log(ctrlUp, ctrlDown);

      for (var i = 0; i < lastIndex + 1; i++){ // lastIndex + 1 because we just added two new events!
        if (statement.trace[i].data){
          statement.trace[i].data.ctrlKey = true; // of course may already be true, which is fine
        }
      }
    }
  }

  function requireFeatures(statement, featureNames){
    if (featureNames.length > 0){ 
      if (!statement.node){
        // sometimes statement.node will be empty, as when we add a scrape statement for known relation item, with no trace associated 
        WALconsole.warn("Hey, you tried to require some features, but there was no Ringer trace associated with the statement.", statement, featureNames);
      }
      ReplayTraceManipulation.requireFeatures(statement.trace, statement.node, featureNames); // note that statement.node stores the xpath of the original node
      ReplayTraceManipulation.requireFeatures(statement.cleanTrace, statement.node, featureNames);
    } 
  }

  var blocklyNames = [];
  function setBlocklyLabel(obj, label){
    //console.log("setBlocklyLabel", obj, label, obj.___revivalLabel___);
    obj.blocklyLabel = label;

    // it's important that we keep track of what things within the WebAutomationLanguage object are blocks and which aren't
    // this may be a convenient way to do it, since it's going to be obvious if you introduce a new block but forget to call this
    // whereas if you introduce a new function and forget to add it to a blacklist, it'll get called randomly, will be hard to debug
    var name = obj.___revivalLabel___;
    blocklyNames.push(name);
    blocklyNames = _.uniq(blocklyNames);
  }

  function addToolboxLabel(label, category){
    if (category === undefined){ category = "other";}
    pub.blocklyLabels[category].push(label);
    pub.blocklyLabels[category] = _.uniq(pub.blocklyLabels[category]);
  }

  function attachToPrevBlock(currBlock, prevBlock){
    if (currBlock && prevBlock){
      var prevBlockConnection = prevBlock.nextConnection;
      var thisBlockConnection = currBlock.previousConnection;
      prevBlockConnection.connect(thisBlockConnection);
    }
    else{
      WALconsole.warn("Woah, tried to attach to a null prevBlock!  Bad!");
    }
  }

  // for things like loops that have bodies, attach the nested blocks
  function attachNestedBlocksToWrapper(wrapperBlock, firstNestedBlock){
    if (!wrapperBlock || !firstNestedBlock){
      WALconsole.warn("Woah, tried attachNestedBlocksToWrapper with", wrapperBlock, firstNestedBlock);
      return;}
    var parentConnection = wrapperBlock.getInput('statements').connection;
    var childConnection = firstNestedBlock.previousConnection;
    parentConnection.connect(childConnection);
  }

  function attachToInput(leftBlock, rightBlock, name){
    if (!leftBlock || !rightBlock || !name){
      WALconsole.warn("Woah, tried attachToInput with", leftBlock, rightBlock, name);
      return;
    }
    var parentConnection = leftBlock.getInput(name).connection;
    var childConnection = rightBlock.outputConnection;
    parentConnection.connect(childConnection);
  }

  function attachInputToOutput(leftBlock, rightBlock){
    if (!leftBlock || !rightBlock){
      WALconsole.warn("Woah, tried attachInputToOutput with", leftBlock, rightBlock);
      return;
    }
    var outputBlockConnection = rightBlock.outputConnection;
    var inputBlockConnection = leftBlock.inputList[0].connection;
    outputBlockConnection.connect(inputBlockConnection);
  }

  function helenaSeqToBlocklySeq(statementsLs, workspace){
    // get the individual statements to produce their corresponding blockly blocks
    var firstNonNull = null; // the one we'll ultimately return, in case it needs to be attached to something outside

    var lastBlock = null;
    var lastStatement = null;

    var invisibleHead = [];

    for (var i = 0; i < statementsLs.length; i++){
      var newBlock = statementsLs[i].genBlocklyNode(lastBlock, workspace);
      // within each statement, there can be other program components that will need blockly representations
      // but the individual statements are responsible for traversing those
      if (newBlock !== null){ // handle the fact that there could be null-producing nodes in the middle, and need to connect around those
        lastBlock = newBlock;
        lastStatement = statementsLs[i];
        lastStatement.invisibleHead = [];
        lastStatement.invisibleTail = [];
        // also, if this is our first non-null block it's the one we'll want to return
        if (!firstNonNull){
          firstNonNull = newBlock;
          // oh, and let's go ahead and set that invisible head now
          statementsLs[i].invisibleHead = invisibleHead;
        }
      }
      else{
        // ok, a little bit of special stuff when we do have null nodes
        // we want to still save them, even though we'll be using the blockly code to generate future versions of the program
        // so we'll need to associate these invibislbe statements with others
        // and then the only thing we'll need to do is when we go the other direction (blockly->helena)
        // we'll have to do some special processing to put them back in the normal structure
        statementsLs[i].nullBlockly = true;

        // one special case.  if we don't have a non-null lastblock, we'll have to keep this for later
        // we prefer to make things tails of earlier statements, but we can make some heads if necessary
        if (!lastBlock){
          invisibleHead.push(statementsLs[i]);
        }
        else{
          lastStatement.invisibleTail.push(statementsLs[i]);
        }
      }
    }
    return firstNonNull;
    // todo: the whole invisible head, invisible tail thing isn't going to be any good if we have no visible
    // statements in this segment.  So rare that spending time on it now is probably bad, but should be considered eventually
  }


  function getLoopIterationCountersHelper(s, acc){
    if (s === null || s === undefined){
      return acc;
    }
    if (s instanceof WebAutomationLanguage.LoopStatement){
      acc.unshift(s.rowsSoFar);
    }
    return getLoopIterationCountersHelper(s.parent, acc);
  }

  function getLoopIterationCounters(s){
    return getLoopIterationCountersHelper(s, []);
  }

  function blocklySeqToHelenaSeq(blocklyBlock){
    if (!blocklyBlock){
      return [];
    }
    var thisNodeHelena = getWAL(blocklyBlock).getHelena(); // grab the associated helena component and call the getHelena method
    var invisibleHead = thisNodeHelena.invisibleHead;
    if (!invisibleHead){invisibleHead = [];}
    var invisibleTail = thisNodeHelena.invisibleTail;
    if (!invisibleTail){invisibleTail = [];}
    var helenaSeqForThisBlock = (invisibleHead.concat(thisNodeHelena)).concat(invisibleTail);

    var nextBlocklyBlock = blocklyBlock.getNextBlock();
    if (!nextBlocklyBlock){
      return helenaSeqForThisBlock;
    }
    var suffix = blocklySeqToHelenaSeq(nextBlocklyBlock);
    return helenaSeqForThisBlock.concat(suffix);
  }

  pub.getHelenaFromBlocklyRoot = function(blocklyBlock){
    return blocklySeqToHelenaSeq(blocklyBlock);
  }

  function getInputSeq(blocklyBlock, inputName){
    var nextBlock = blocklyBlock.getInput(inputName).connection.targetBlock();
    if (!nextBlock){
      return [];
    }
    return getWAL(nextBlock).getHelenaSeq();
  }

  // when Blockly blocks are thrown away (in trash cah), you can undo it, but undoing it doesn't bring back the walstatement
  // property that we add
  // so...we'll keep track
  var blocklyToWALDict = {};
  pub.blocklyToWALDict = function _btwd(){
    return blocklyToWALDict;
  }

  function setWAL(block, WALEquiv){
    block.WAL = WALEquiv;
    WALEquiv.block = block;
    blocklyToWALDict[block.id] = WALEquiv;
  }

  function getWAL(block){
    if (!block.WAL){
      block.WAL = blocklyToWALDict[block.id];
      if (block.WAL){
        block.WAL.block = block;
        // the above line may look silly but when blockly drops blocks into the trashcan, they're restored
        // with the same id but with a fresh object
        // and the fresh object doesn't have WAL stored anymore, which is why we have to look in the dict
        // but that also means the block object stored by the wal object is out of date, must be refreshed
      }

    }
    return block.WAL;
  }

  pub.getWALRep = function _getWALRep(blocklyBlock){
    return getWAL(blocklyBlock);
  }

  pub.hasWAL = function _hasWAL(blocklyBlock){
    return blocklyBlock.WAL !== undefined;
  }

  // the actual statements

  pub.LoadStatement = function _LoadStatement(trace){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "load");
    if (trace){ // we will sometimes initialize with undefined, as when reviving a saved program
      this.trace = trace;

      // find the record-time constants that we'll turn into parameters
      var ev = firstVisibleEvent(trace);
      this.url = ev.data.url;
      this.outputPageVar = EventM.getLoadOutputPageVar(ev);
      this.outputPageVars = [this.outputPageVar]; // this will make it easier to work with for other parts of the code
      // for now, assume the ones we saw at record time are the ones we'll want at replay
      this.currentUrl = new pub.String(this.url);

      // usually 'completed' events actually don't affect replayer -- won't load a new page in a new tab just because we have one.  want to tell replayer to actually do a load
      ev.forceReplay = true;

      this.cleanTrace = cleanTrace(trace);    
    }

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      if (this.currentUrl && this.currentUrl.run){
        this.currentUrl.run(runObject, rbbcontinuation, rbboptions);
      }
    }

    this.cUrl = function _cUrl(environment){
      if (this.currentUrl instanceof WebAutomationLanguage.NodeVariable){
        return this.currentUrl.currentText(environment); // todo: hmmmm, really should have nodevariableuse, not node variable here.  test with text relation uploads
      }
      else if (this.currentUrl instanceof WebAutomationLanguage.NodeVariableUse){
        return this.currentUrl.getCurrentVal(); // todo: hmmmm, really should have nodevariableuse, not node variable here.  test with text relation uploads
      }
      else if (this.currentUrl instanceof pub.String || this.currentUrl instanceof pub.Concatenate){
        this.currentUrl.run();
        return this.currentUrl.getCurrentVal();
      }
      else {
        WALconsole.warn("We should never have a load statement whose currentURL isn't a nodevar, string, or string bin op!");
      }
    }

    // deprecated
    this.cUrlString = function _cUrlString(){
      if (this.currentUrl instanceof WebAutomationLanguage.NodeVariable){
        return this.currentUrl.toString();
      }
      else {
        // else it's a string
        return this.currentUrl;
      }
    }

    this.getUrlObj = function _getUrlObj(){
      // if (this.currentUrl instanceof WebAutomationLanguage.NodeVariable || this.currentUrl instanceof pub.String || this.currentUrl instanceof pub.BinOpString){
      if (typeof this.currentUrl === "string"){
        // sometimes it's a string; this is left over from before, when we used to store the string internally
        // rather than as a proper block
        // let's go ahead and correct it now
        this.currentUrl = new pub.String(this.currentUrl); // we'll make a little string node for it
      }

      if (this.currentUrl instanceof pub.NodeVariable){
        // hey, we don't want NodeVariable as the item--we want a NodeVariableUse
        var nodevaruse = new pub.NodeVariableUse();
        nodevaruse.nodeVar = this.currentUrl;
        nodevaruse.attributeOption = AttributeOptions.TEXT;
        this.currentUrl = nodevaruse;
      }
      
      return this.currentUrl;
    }

    this.toStringLines = function _toStringLines(){
      var cUrl = this.cUrlString();
      return [this.outputPageVar.toString()+" = load("+cUrl+")"];
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      // uses the program obj, so only makes sense if we have one
      if (!program){return;}
      // addToolboxLabel(this.blocklyLabel, "web");
      var pageVarsDropDown = makePageVarsDropdown(pageVars);

      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendDummyInput()
              .appendField("load")
          this.appendValueInput("url");
          this.appendDummyInput()
              //.appendField(new Blockly.FieldTextInput("URL", handleNewUrl), "url")
              .appendField("into")
              .appendField(new Blockly.FieldDropdown(pageVarsDropDown), "page");
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
          this.setColour(280);
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      if (this.currentUrl){
        var urlWALObject = this.getUrlObj();
        attachToInput(this.block, urlWALObject.genBlocklyNode(this.block, workspace), "url");
      }
      this.block.setFieldValue(this.outputPageVar.toString(), "page");
      attachToPrevBlock(this.block, prevBlock);
      setWAL(this.block, this);
      return this.block;
    };

    this.getHelena = function _getHelena(){
      // ok, but we also want to update our own url object
      var url = this.block.getInput('url').connection.targetBlock();
      if (url){
        this.currentUrl = getWAL(url).getHelena();
      }
      else{
        this.currentUrl = null;
      }
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      if (this.currentUrl && this.currentUrl.traverse){
        this.currentUrl.traverse(fn, fn2);
      }
      fn2(this);
    };

    this.pbvs = function _pbvs(){
      var pbvs = [];
      if (this.url !== this.currentUrl){
        pbvs.push({type:"url", value: this.url});
      }
      return pbvs;
    };

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      // ok!  loads can now get changed based on relations!
      // what we want to do is load a different url if we have a relation that includes the url
      var columns = relation.columns;
      var firstRowNodeRepresentations = relation.firstRowNodeRepresentations();
      // again, must have columns and firstRowNodeRepresentations aligned.  should be a better way
      for (var i = 0; i < columns.length; i++){
        var text = columns[i].firstRowText;
        if (text === null || text === undefined){
          // can't parameterize for a cell that has null text
          continue;
        }
        if (urlMatch(text, this.cUrl())){
          // ok, we want to parameterize
          this.relation = relation;
          var name = relation.columns[i].name;

          var nodevaruse = new pub.NodeVariableUse();
          nodevaruse.nodeVar = getNodeVariableByName(name);
          nodevaruse.attributeOption = AttributeOptions.TEXT;
          this.currentUrl = nodevaruse; // new WebAutomationLanguage.NodeVariable(name, firstRowNodeRepresentations[i], null, null, NodeSources.RELATIONEXTRACTOR);
          return relation.columns[i];
        }
      }
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      if (this.relation === relation){
        this.relation = null;
        this.currentUrl = this.url;
      }
      return;
    };

    this.args = function _args(environment){
      var args = [];
      var currentUrl = this.cUrl(environment);
      args.push({type:"url", value: currentUrl.trim()});
      return args;
    };

    this.postReplayProcessing = function _postReplayProcessing(runObject, trace, temporaryStatementIdentifier){
      return;
    };
  };
  pub.ClickStatement = function _ClickStatement(trace){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "click");
    if (trace){ // we will sometimes initialize with undefined, as when reviving a saved program
      this.trace = trace;

      // find the record-time constants that we'll turn into parameters
      var ev = firstVisibleEvent(trace);
      this.pageVar = EventM.getDOMInputPageVar(ev);
      this.pageUrl = ev.frame.topURL;
      this.node = ev.target.xpath;
      var domEvents = _.filter(trace, function(ev){return ev.type === "dom";}); // any event in the segment may have triggered a load
      var outputLoads = _.reduce(domEvents, function(acc, ev){return acc.concat(EventM.getDOMOutputLoadEvents(ev));}, []);
      this.outputPageVars = _.map(outputLoads, function(ev){return EventM.getLoadOutputPageVar(ev);});
      // for now, assume the ones we saw at record time are the ones we'll want at replay
      // this.currentNode = this.node;
      this.origNode = this.node;

      // we may do clicks that should open pages in new tabs but didn't open new tabs during recording
      // todo: may be worth going back to the ctrl approach, but there are links that refuse to open that way, so for now let's try back buttons
      // proposeCtrlAdditions(this);
      this.cleanTrace = cleanTrace(this.trace);

      // actually we want the currentNode to be a nodeVariable so we have a name for the scraped node
      this.currentNode = makeNodeVariableForTrace(trace);
    }

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      if (this.currentNode instanceof WebAutomationLanguage.NodeVariable){
        var feats = this.currentNode.getRequiredFeatures();
        requireFeatures(this, feats);
      }
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      var nodeRep = nodeRepresentation(this);
      return [outputPagesRepresentation(this)+"click("+nodeRep+")"];
    };

    var maxDim = 50;
    var maxHeight = 20;
    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      // uses the program obj, so only makes sense if we have one
      if (!program){return;}
      // addToolboxLabel(this.blocklyLabel, "web");
      var pageVarsDropDown = makePageVarsDropdown(pageVars);
      var shapes = ["", "ringer", "output", "ringeroutput"];
      for (var i = 0; i < shapes.length; i++){
        var label = this.blocklyLabel + "_" + shapes[i];;
        (function(){
          var sl = label;
          Blockly.Blocks[sl] = {
            init: function() {
              var shapeLabel = sl;
              var fieldsSoFar = this.appendDummyInput()
                  .appendField("click");

              // let's decide how to display the node
              if (shapeLabel.indexOf("ringer") > -1){
                // it's just a ringer-identified node, use the pic
                fieldsSoFar = fieldsSoFar.appendField(new Blockly.FieldImage("node", maxDim, maxHeight, "node image"), "node");
              }
              else{
                // it has a name so just use the name
                fieldsSoFar = fieldsSoFar.appendField(new Blockly.FieldTextInput("node"), "node");
              }
              fieldsSoFar = fieldsSoFar.appendField("in")
                  .appendField(new Blockly.FieldDropdown(pageVarsDropDown), "page");

              // let's decide whether there's an output page
              if (shapeLabel.indexOf("output") > -1){
                fieldsSoFar = fieldsSoFar.appendField(", load page into")
                  .appendField(new Blockly.FieldDropdown(pageVarsDropDown), "outputPage");
              }
              this.setPreviousStatement(true, null);
              this.setNextStatement(true, null);
              this.setColour(280);
            },
            onchange: function(ev) {
              var newName = this.getFieldValue("node");
              var currentName = getWAL(this).currentNode.getName();
              if (newName !== currentName){
                var wal = getWAL(this);
                wal.currentNode.setName(newName);
                // new name so update all our program display stuff
                UIObject.updateDisplayedScript(false); // update without updating how blockly appears
                var colObj = wal.currentColumnObj(); // now make sure the relation column gets renamed too
                if (colObj){
                  colObj.name = newName;
                  UIObject.updateDisplayedRelations();
                }
              }
              if (ev instanceof Blockly.Events.Ui){
                if (ev.element === "selected" && ev.oldValue === this.id){ // unselected
                  UIObject.updateDisplayedScript(true);
                }
              }
            }
          };
        })();
      }
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      var label = this.blocklyLabel + "_";

      if (this.currentNode.getSource() === NodeSources.RINGER){
        label += "ringer";
      }
      if (this.outputPageVars && this.outputPageVars.length > 0){
        label += "output";
      }

      this.block = workspace.newBlock(label);

      if (this.currentNode.getSource() === NodeSources.RINGER){
        this.block.setFieldValue(nodeRepresentation(this), "node", maxDim, maxHeight, "node image");
      }
      else{
        this.block.setFieldValue(nodeRepresentation(this), "node");
      }
      if (this.outputPageVars && this.outputPageVars.length > 0){
        this.block.setFieldValue(this.outputPageVars[0].toString(), "outputPage");
      }

      this.block.setFieldValue(this.pageVar.toString(), "page");

      attachToPrevBlock(this.block, prevBlock);
      setWAL(this.block, this);
      return this.block;
    };

    this.getHelena = function _getHelena(){
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      fn2(this);
    };

    this.pbvs = function _pbvs(){
      var pbvs = [];
      if (currentTab(this)){
        // do we actually know the target tab already?  if yes, go ahead and paremterize that
        pbvs.push({type:"tab", value: originalTab(this)});
      }
      if (this.currentNode instanceof WebAutomationLanguage.NodeVariable && this.currentNode.getSource() === NodeSources.RELATIONEXTRACTOR){ // we only want to pbv for things that must already have been extracted by relation extractor
        pbvs.push({type:"node", value: this.node});
      }
      return pbvs;
    };

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [parameterizeNodeWithRelation(this, relation, this.pageVar)];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      unParameterizeNodeWithRelation(this, relation);
    };

    this.args = function _args(environment){
      var args = [];
      args.push({type:"tab", value: currentTab(this)});
      if (this.currentNode instanceof WebAutomationLanguage.NodeVariable && this.currentNode.getSource() === NodeSources.RELATIONEXTRACTOR){ // we only want to pbv for things that must already have been extracted by relation extractor
        args.push({type:"node", value: currentNodeXpath(this, environment)});
      }
      return args;
    };

    this.postReplayProcessing = function _postReplayProcessing(runObject, trace, temporaryStatementIdentifier){
      return;
    };

    this.currentRelation = function _currentRelation(){
      return this.relation;
    };

    this.currentColumnObj = function _currentColumnObj(){
      return this.columnObj;
    };
  };

  function firstScrapedContentEventInTrace(ourStatementTraceSegment){
    for (var i = 0; i < ourStatementTraceSegment.length; i++){
      if (ourStatementTraceSegment[i].additional && ourStatementTraceSegment[i].additional.scrape && ourStatementTraceSegment[i].additional.scrape.text){
        return ourStatementTraceSegment[i];
      }
    }
    return null;
  }

  pub.ScrapeStatement = function _ScrapeStatement(trace){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "scrape");

    this.associatedOutputStatements = [];

    if (trace){ // we will sometimes initialize with undefined, as when reviving a saved program
      this.trace = trace;
      this.cleanTrace = cleanTrace(this.trace);

      if (trace.length > 0){ // may get 0-length trace if we're just adding a scrape statement by editing (as for a known column in a relation)
        // find the record-time constants that we'll turn into parameters
        var ev = firstVisibleEvent(trace);
        this.pageVar = EventM.getDOMInputPageVar(ev);
        this.node = ev.target.xpath;
        this.pageUrl = ev.frame.topURL;
        // for now, assume the ones we saw at record time are the ones we'll want at replay
        //this.currentNode = this.node;
        this.origNode = this.node;

        // are we scraping a link or just the text?
        this.scrapeLink = false;
        for (var i = 0; i <  trace.length; i++){
          if (trace[i].additional && trace[i].additional.scrape){
            if (trace[i].additional.scrape.linkScraping){
              this.scrapeLink = true;
              break;
            }
          }
        }
      }

      // actually we want the currentNode to be a nodeVariable so we have a name for the scraped node
      this.currentNode = makeNodeVariableForTrace(trace);
    }

    this.remove = function _remove(){
      this.parent.removeChild(this);
      for (var i = 0; i < this.associatedOutputStatements.length; i++){
        this.associatedOutputStatements[i].removeAssociatedScrapeStatement(this);
      }
    }

    this.prepareToRun = function _prepareToRun(){
      if (this.currentNode instanceof WebAutomationLanguage.NodeVariable){
        var feats = this.currentNode.getRequiredFeatures();
        requireFeatures(this, feats);
      }
    };
    this.clearRunningState = function _clearRunningState(){
      this.xpaths = [];
      this.preferredXpath = null;
      return;
    }

    this.toStringLines = function _toStringLines(){
      var alreadyBound = this.currentNode instanceof WebAutomationLanguage.NodeVariable && this.currentNode.getSource === NodeSources.RELATIONEXTRACTOR; // todo: could be it's already bound even without being relation extracted, so should really handle that
      if (alreadyBound){
        return ["scrape(" + this.currentNode.getName() + ")"];
      }
      var nodeRep = nodeRepresentation(this, this.scrapeLink);
      var sString = "scrape(";
      //if (this.scrapeLink){
      //  sString = "scrapeLink(";
      //}
      return [sString + nodeRep+", "+this.currentNode.getName()+")"];
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      // uses the program obj, so only makes sense if we have one
      if (!program){return;}
      // addToolboxLabel(this.blocklyLabel, "web");
      var pageVarsDropDown = makePageVarsDropdown(pageVars);
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendDummyInput()
              .appendField("scrape")
              .appendField(new Blockly.FieldTextInput("node"), "node") // switch to pulldown
              .appendField("in")
              .appendField(new Blockly.FieldDropdown(pageVarsDropDown), "page");
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
          this.setColour(280);
        },
        onchange: function(ev) {
          var newName = this.getFieldValue("node");
          var currentName = getWAL(this).currentNode.getName();
          if (newName !== currentName){
            var wal = getWAL(this);
            wal.currentNode.setName(newName);
            // new name so update all our program display stuff
            UIObject.updateDisplayedScript(false); // update without updating how blockly appears
            var colObj = wal.currentColumnObj(); // now make sure the relation column gets renamed too
            if (colObj){
              colObj.name = newName;
              UIObject.updateDisplayedRelations();
            }
          }
          if (ev instanceof Blockly.Events.Ui){
            if (ev.element === "selected" && ev.oldValue === this.id){ // unselected
              UIObject.updateDisplayedScript(true);
            }
          }
        }
      };

      // now any blockly blocks we'll need but don't want to have in the toolbox for whatever reason
      // (usually because we can only get the statement from ringer)
      this.updateAlternativeBlocklyBlock(program, pageVars, relations);
    };

    var maxDim = 50;
    var maxHeight = 20;
    this.alternativeBlocklyLabel = "scrape_ringer"
    this.updateAlternativeBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      // uses the program obj, so only makes sense if we have one
      if (!program){return;}

      var pageVarsDropDown = makePageVarsDropdown(pageVars);
      var defaultName = "name";
      var lastUpdateTime = 0;
      Blockly.Blocks[this.alternativeBlocklyLabel] = {
        init: function() {
          this.appendDummyInput()
              .appendField("scrape")
              .appendField(new Blockly.FieldImage("node", maxDim, maxHeight, "node image"), "node")
              .appendField("in")
              .appendField(new Blockly.FieldDropdown(pageVarsDropDown), "page")
              .appendField("and call it")
              .appendField(new Blockly.FieldTextInput(defaultName), "name");
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
          this.setColour(280);
        },
        onchange: function(ev) {
          var newName = this.getFieldValue("name");
          var currentName = getWAL(this).currentNode.getName();
          if (newName !== defaultName && (newName !== currentName)){
            getWAL(this).currentNode.setName(newName);
            // new name so update all our program display stuff
            UIObject.updateDisplayedScript(false); // update without updating how blockly appears
          }
          if (ev instanceof Blockly.Events.Ui){
            if (ev.element === "selected" && ev.oldValue === this.id){ // unselected
              UIObject.updateDisplayedScript(true);
            }
          }
        }
      };
    };


    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      if (this.relation){
        // scrapes a relation node
        this.block = workspace.newBlock(this.blocklyLabel);
        this.block.setFieldValue(nodeRepresentation(this), "node");
      }
      else{
        // ah, a ringer-scraped node
        this.block = workspace.newBlock(this.alternativeBlocklyLabel);
        this.block.setFieldValue(this.currentNode.getName(), "name");
        this.block.setFieldValue(nodeRepresentation(this), "node", maxDim, maxHeight, "node image");
      }
      this.block.setFieldValue(this.pageVar.toString(), "page");
      attachToPrevBlock(this.block, prevBlock);
      setWAL(this.block, this);
      return this.block;
    };

    this.getHelena = function _getHelena(){
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      fn2(this);
    };

    this.scrapingRelationItem = function _scrapingRelationItem(){
      return this.relation !== null && this.relation !== undefined;
    };

    this.pbvs = function _pbvs(){
      var pbvs = [];
      if (this.trace.length > 0){ // no need to make pbvs based on this statement's parameterization if it doesn't have any events to parameterize anyway...
        if (currentTab(this)){
          // do we actually know the target tab already?  if yes, go ahead and paremterize that
          pbvs.push({type:"tab", value: originalTab(this)});
        }
        if (this.scrapingRelationItem()){
          pbvs.push({type:"node", value: this.node});
        }
        if (this.preferredXpath){
          // using the usual pbv process happens to be a convenient way to enforce a preferred xpath, since it sets it to prefer a given xpath
          // and replaces all uses in the trace of a given xpath with a preferred xpath
          // but may prefer to extract this non-relation based pbv process from the normal relation pbv.  we'll see
          // side note: the node pbv above will only appear if it's a use of a relation cell, and this one will only appear if it's not
          pbvs.push({type:"node", value: this.node});
        }
      }

      return pbvs;
    };

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      WALconsole.log("scraping cleantrace", this.cleanTrace);
      var relationColumnUsed = parameterizeNodeWithRelation(this, relation, this.pageVar); // this sets the currentNode
      if (relationColumnUsed){
        return [relationColumnUsed];
      }
      else {
        return [];
      }
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      var columnObject = unParameterizeNodeWithRelation(this, relation);
      // todo: right now we're assuming we only scrape a given column once in a given script, so if we unparameterize here
      // we assume no where else is scraping this column, and we reset the column object's scraped value
      // but there's no reason for this assumption to be true.  it doesn't matter much, so not fixing it now.  but fix in future
      if (columnObject){ // will be null if we're not actually unparameterizing anything
        colObject.scraped = false; // should really do reference counting
      }

      // have to go back to actually running the scraping interactions...
      // note! right now unparameterizing a scrape statement adds back in all the removed scraping events, which won't always be necessary
      // should really do it on a relation by relation basis, only remove the ones related to the current relation
      this.cleanTrace = cleanTrace(this.trace);
    };

    this.args = function _args(environment){
      var args = [];
      if (this.trace.length > 0){ // no need to make pbvs based on this statement's parameterization if it doesn't have any events to parameterize anyway...
        if (this.scrapingRelationItem()){
          args.push({type:"node", value: currentNodeXpath(this, environment)});
        }
        args.push({type:"tab", value: currentTab(this)});
        if (this.preferredXpath){
          args.push({type:"node", value: this.preferredXpath});
        }
      }
      return args;
    };

    this.xpaths = [];
    this.postReplayProcessing = function _postReplayProcessing(runObject, trace, temporaryStatementIdentifier){

      if (!this.scrapingRelationItem()){
        // ok, this was a ringer-run scrape statement, so we have to grab the right node out of the trace

        // it's not just a relation item, so relation extraction hasn't extracted it, so we have to actually look at the trace
        // find the scrape that corresponds to this scrape statement based on temporarystatementidentifier
        var ourStatementTraceSegment = _.filter(trace, function(ev){return EventM.getTemporaryStatementIdentifier(ev) === temporaryStatementIdentifier;});
        var scrapedContentEvent = firstScrapedContentEventInTrace(ourStatementTraceSegment);
        if (scrapedContentEvent){
          // for now, all scrape statements have a NodeVariable as currentNode, so can call setCurrentNodeRep to bind name in current environment
          this.currentNode.setCurrentNodeRep(runObject.environment, scrapedContentEvent.additional.scrape);  
        }
        else {
          this.currentNode.setCurrentNodeRep(runObject.environment, null);
        }

        // it's not a relation item, so let's start keeping track of the xpaths of the nodes we actually find, so we can figure out if we want to stop running full similarity
        // note, we could factor this out and let this apply to other statement types --- clicks, typing
        // but empirically, have mostly had this issue slowing down scraping, not clicks and the like, since there are usually few of those
        if (!this.preferredXpath){ // if we haven't yet picked a preferredXpath...
          if (scrapedContentEvent){
            var firstNodeUse = scrapedContentEvent;
            var xpath = firstNodeUse.target.xpath;
            this.xpaths.push(xpath);
            if (this.xpaths.length === 5){
              // ok, we have enough data now that we might be able to decide to do something smarter
              var uniqueXpaths = _.uniq(this.xpaths);
              if (uniqueXpaths.length === 1){
                // we've used the exact same one this whole time...  let's try using that as our preferred xpath
                this.preferredXpath = uniqueXpaths[0];
              }
            }
          }
        }
        else {
          // we've already decided we have a preferred xpath.  we should check and make sure we're still using it.  if we had to revert to using similarity
          // we should stop trying to use the current preferred xpath, start tracking again.  maybe the page has been redesigned and we can discover a new preferred xpath
          // so we'll enter that phase again
          if (scrapedContentEvent){ // only make this call if we actually have an event that aligns...
            var firstNodeUse = scrapedContentEvent; 
            var xpath = firstNodeUse.target.xpath;
            if (xpath !== this.preferredXpath){
              this.preferredXpath = null;
              this.xpaths = [];
            }      
          }

        }
      }

      // and now get the answer in a way that works both for relation-scraped and ringer-scraped, because of using NodeVariable
      this.currentNodeCurrentValue = this.currentNode.currentNodeRep(runObject.environment);
      if (!this.currentNodeCurrentValue){
        this.currentNodeCurrentValue = {}; // todo: is it ok to just use an empty entry as a cell when we find none?
      }

      if (this.scrapeLink){
        this.currentNodeCurrentValue.scraped_attribute = "LINK";
      }
      else{
        this.currentNodeCurrentValue.scraped_attribute = "TEXT";
      }

    };

    this.addAssociatedOutputStatement = function _addAssociatedOutputStatement(outputStatement){
      this.associatedOutputStatements.push(outputStatement);
      this.associatedOutputStatements = _.uniq(this.associatedOutputStatements);
    };
    this.removeAssociatedOutputStatement = function _removeAssociatedOutputStatement(outputStatement){
      this.associatedOutputStatements = _.without(this.associatedOutputStatements, outputStatement);
    }

    this.currentRelation = function _currentRelation(){
      return this.relation;
    };

    this.currentColumnObj = function _currentColumnObj(){
      return this.columnObj;
    };   
  };

  pub.TypeStatement = function _TypeStatement(trace){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "type");
    if (trace){ // we will sometimes initialize with undefined, as when reviving a saved program
      this.trace = trace;
      this.cleanTrace = cleanTrace(trace);

      // find the record-time constants that we'll turn into parameters
      var ev = firstVisibleEvent(trace);
      this.pageVar = EventM.getDOMInputPageVar(ev);
      this.node = ev.target.xpath;
      this.pageUrl = ev.frame.topURL;
      var acceptableEventTypes = statementToEventMapping.keyboard;
      var textEntryEvents = _.filter(trace, function(ev){var sType = WebAutomationLanguage.statementType(ev); return (sType === StatementTypes.KEYBOARD || sType === StatementTypes.KEYUP);});
      if (textEntryEvents.length > 0){
        var lastTextEntryEvent = textEntryEvents[textEntryEvents.length - 1];
        this.typedString = lastTextEntryEvent.target.snapshot.value;
        if (!this.typedString){
          this.typedString = "";
        }
        this.typedStringLower = this.typedString.toLowerCase(); 
      }

      var domEvents = _.filter(trace, function(ev){return ev.type === "dom";}); // any event in the segment may have triggered a load
      var outputLoads = _.reduce(domEvents, function(acc, ev){return acc.concat(EventM.getDOMOutputLoadEvents(ev));}, []);
      this.outputPageVars = _.map(outputLoads, function(ev){return EventM.getLoadOutputPageVar(ev);});
      // for now, assume the ones we saw at record time are the ones we'll want at replay
      this.currentNode = this.currentNode = makeNodeVariableForTrace(trace);
      this.origNode = this.node;
      this.currentTypedString = new pub.String(this.typedString);

      // we want to do slightly different things for cases where the typestatement only has keydowns or only has keyups (as when ctrl, shift, alt used)
      var onlyKeydowns = _.reduce(textEntryEvents, function(acc, e){return acc && e.data.type === "keydown"}, true);
      if (onlyKeydowns){
        this.onlyKeydowns = true;
      }
      var onlyKeyups = _.reduce(textEntryEvents, function(acc, e){return acc && (e.data.type === "keyup")}, true); // all events are keyups or invisible
      if (onlyKeyups){
        this.onlyKeyups = true;
      }
      if (onlyKeydowns || onlyKeyups){
        this.keyEvents = textEntryEvents;
        this.keyCodes = _.map(this.keyEvents, function(ev){ return ev.data.keyCode; });
      }
    };


    this.remove = function _remove(){
      this.parent.removeChild(this);
    };

    this.prepareToRun = function _prepareToRun(){
      if (this.currentNode instanceof WebAutomationLanguage.NodeVariable){
        var feats = this.currentNode.getRequiredFeatures();
        requireFeatures(this, feats);
      }
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    };

    this.stringRep = function _typedString(){
      var stringRep = "";
      if (this.currentTypedString instanceof WebAutomationLanguage.Concatenate){
        stringRep = this.currentTypedString.toString();
      }
      else{
        stringRep = this.currentTypedString;
      }
      return stringRep;
    };

    this.toStringLines = function _toStringLines(){
      if (!this.onlyKeyups && !this.onlyKeydowns){
        // normal processing, for when there's actually a typed string
        var stringRep = this.stringRep();
        return [outputPagesRepresentation(this)+"type("+this.pageVar.toString()+", "+stringRep+")"];
      }
      else{
        return [];
        /*
        var charsDict = {16: "SHIFT", 17: "CTRL", 18: "ALT", 91: "CMD"}; // note that 91 is the command key in Mac; on Windows, I think it's the Windows key; probably ok to use cmd for both
        var chars = [];
        _.each(this.keyEvents, function(ev){
          if (ev.data.keyCode in charsDict){
            chars.push(charsDict[ev.data.keyCode]);
          }
        });
        var charsString = chars.join(", ");
        var act = "press"
        if (this.onlyKeyups){
          act = "let up"
        }
        return [act + " " + charsString + " on " + this.pageVar.toString()];
        */
      }
    };


    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      // uses the program obj, so only makes sense if we have one
      if (!program){return;}
      // addToolboxLabel(this.blocklyLabel, "web");
      var pageVarsDropDown = makePageVarsDropdown(pageVars);
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendDummyInput()
              .appendField("type");
          this.appendValueInput("currentTypedString");
          this.appendDummyInput()
              .appendField("in")
              .appendField(new Blockly.FieldDropdown(pageVarsDropDown), "page");
          this.setInputsInline(true);
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
          this.setColour(280);
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      if (this.onlyKeyups || this.onlyKeydowns || (this.currentTypedString && this.currentTypedString.hasText && !this.currentTypedString.hasText())){
        return null;
      }
      else{
        this.block = workspace.newBlock(this.blocklyLabel);
        this.block.setFieldValue(this.pageVar.toString(), "page");
        attachToPrevBlock(this.block, prevBlock);
        setWAL(this.block, this);

        if (this.currentTypedString){
          attachToInput(this.block, this.currentTypedString.genBlocklyNode(this.block, workspace), "currentTypedString");
        }

        return this.block;
      }
    };

    this.getHelena = function _getHelena(){
      var currentTypedString = this.block.getInput('currentTypedString').connection.targetBlock();
      if (currentTypedString){
        this.currentTypedString = getWAL(currentTypedString).getHelena();
      }
      else{
        this.currentTypedString = null;
      }
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      if (this.currentTypedString){
        this.currentTypedString.traverse(fn, fn2);
      }
      fn2(this);
    };

    this.pbvs = function _pbvs(){
      var pbvs = [];
      if (currentTab(this)){
        // do we actually know the target tab already?  if yes, go ahead and paremterize that
        pbvs.push({type:"tab", value: originalTab(this)});
      }
      if (this.currentNode instanceof WebAutomationLanguage.NodeVariable && this.currentNode.getSource() === NodeSources.RELATIONEXTRACTOR){ // we only want to pbv for things that must already have been extracted by relation extractor
        pbvs.push({type:"node", value: this.node});
      }
      if (this.typedString !== this.currentTypedString){
        if (this.typedString.length > 0){
          pbvs.push({type:"typedString", value: this.typedString});
        }
      }
      return pbvs;
    };

    var statement = this;

    this.parameterizeForString = function(relation, column, nodeRep, string){
      if (string === null || string === undefined){
        // can't parameterize for a cell that has null text
        return;
      }
      var textLower = string.toLowerCase();
      var startIndex = this.typedStringLower.indexOf(textLower);
      if (startIndex > -1){
        // cool, this is the column for us then

        statement.relation = relation;
        statement.columnObj = column;
        var name = column.name;

        var components = [];
        var left = string.slice(0, startIndex);
        if (left.length > 0){
          components.push(new WebAutomationLanguage.String(left));
        }

        var nodevaruse = new pub.NodeVariableUse();
        nodevaruse.nodeVar = getNodeVariableByName(name);
        nodevaruse.attributeOption = AttributeOptions.TEXT;
        components.push(nodevaruse);

        var right = string.slice(startIndex + this.typedString.length, string.length);
        if (right.length > 0){
          components.push(new WebAutomationLanguage.String(right));
        }

        var finalNode = null;
        if (components.length == 1){
          finalNode = components[0];
        }
        else if (components.length == 2){
          finalNode = new WebAutomationLanguage.Concatenate(components[0], components[1]);
        }
        else if (components.length === 3){
          finalNode = new WebAutomationLanguage.Concatenate(components[0], new WebAutomationLanguage.Concatenate(components[1], components[2]));
        }
        this.currentTypedString = finalNode;
        this.typedStringParameterizationRelation = relation;
        return true;
      }
      return false;
    }

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      var relationColumnUsed = parameterizeNodeWithRelation(this, relation, this.pageVar);

      if (!this.onlyKeydowns && !this.onlyKeyups){
        // now let's also parameterize the text
        var columns = relation.columns;
        var firstRowNodeRepresentations = relation.firstRowNodeRepresentations();
        for (var i = 0; i < columns.length; i++){
          var text = columns[i].firstRowText;
          var paramed = this.parameterizeForString(relation, columns[i], firstRowNodeRepresentations[i], text);
          if (paramed){ return [relationColumnUsed, columns[i]]; }
        }
      }

      return [relationColumnUsed];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      unParameterizeNodeWithRelation(this, relation);
      if (this.typedStringParameterizationRelation === relation){
        this.currentTypedString = new pub.String(this.typedString);
      }
    };

    function currentNodeText(statement, environment){
      return statement.currentTypedString.getCurrentVal();
    }

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      if (this.currentTypedString){
        this.currentTypedString.run(runObject, rbbcontinuation, rbboptions);
      }
    }

    this.args = function _args(environment){
      var args = [];
      if (this.currentNode instanceof WebAutomationLanguage.NodeVariable && this.currentNode.getSource() === NodeSources.RELATIONEXTRACTOR){ // we only want to pbv for things that must already have been extracted by relation extractor
        args.push({type:"node", value: currentNodeXpath(this, environment)});
      }
      args.push({type:"typedString", value: this.currentTypedString.getCurrentVal()});
      args.push({type:"tab", value: currentTab(this)});
      return args;
    };

    this.postReplayProcessing = function _postReplayProcessing(runObject, trace, temporaryStatementIdentifier){
      return;
    };

    this.currentRelation = function _currentRelation(){
      return this.relation;
    };

    this.currentColumnObj = function _currentColumnObj(){
      return this.columnObj;
    };

  };


  pub.PulldownInteractionStatement = function _PulldownInteractionStatement(trace){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "pulldownInteraction");
    if (trace){ // we will sometimes initialize with undefined, as when reviving a saved program
      this.trace = trace;
      this.cleanTrace = cleanTrace(trace);// find the record-time constants that we'll turn into parameters
      var ev = firstVisibleEvent(trace);
      this.pageVar = EventM.getDOMInputPageVar(ev);
      this.node = ev.target.xpath;
      this.origNode = this.node;
      //  we want the currentNode to be a nodeVariable so we have a name for the scraped node
      this.currentNode = makeNodeVariableForTrace(trace);
    }

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      return ["pulldown interaction"];
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      // uses the program obj, so only makes sense if we have one
      if (!program){return;}
      // addToolboxLabel(this.blocklyLabel, "web");
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendDummyInput()
              .appendField("pulldown interaction");
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
          this.setColour(280);
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      attachToPrevBlock(this.block, prevBlock);
      setWAL(this.block, this);
      return this.block;
    };

    this.getHelena = function _getHelena(){
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      fn2(this);
    };

    function deleteAPropDelta(trace, propertyName){
      for (var i = 0; i< trace.length; i++){
        if (trace[i].type !== "dom"){ continue;}
        var deltas = trace[i].meta.deltas;
        if (deltas){
          for (var j = 0; j < deltas.length; j++){
            var delta = deltas[j];
            if (delta.divergingProp === propertyName){
              deltas.splice(j, 1); // throw out the relevant delta
            }
          }
        }
      }
    }

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      var col = parameterizeNodeWithRelation(this, relation, this.pageVar);
      // if we did actually parameterize, we need to do something kind of weird.  need to replace the trace with something that just sets 'selected' to true for the target node
      if (col){
        this.origTrace = this.trace;
        this.origCleanTrace = this.cleanTrace;
        var trace = MiscUtilities.dirtyDeepcopy(this.trace); // clone it.  update it.  put the xpath in the right places.  put a delta for 'selected' being true
        for (var i = 0; i < trace.length; i++){
          if (trace[i].meta){
            trace[i].meta.forceProp = ({selected: true});
          }
        }
        deleteAPropDelta(trace, "value"); // don't try to update the value of select node just update the selectindex
        this.trace = trace;
        this.cleanTrace = cleanTrace(this.trace);
      }
      return [col];
    };

    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      var col = unParameterizeNodeWithRelation(this, relation);
      // if we did find a col, need to undo the thing where we replaced the trace with the 'selected' update, put the old trace back in
      if (col){
        this.trace = this.origTrace;
        this.cleanTrace = this.origCleanTrace;
        this.origTrace = null; // just to be clean
        this.origCleanTrace = null;
      }
    };

    function firstUpdateToProp(trace, propertyName){
      for (var i = 0; i< trace.length; i++){
        if (trace[i].type !== "dom"){ continue;}
        var deltas = trace[i].meta.deltas;
        if (deltas){
          for (var j = 0; j < deltas.length; j++){
            var delta = deltas[j];
            if (delta.divergingProp === propertyName){
              var props = delta.changed.prop;
              for (var key in props){
                if (key === propertyName){
                  // phew, finally found it.  grab it from the changed, not the original snapshot (want what it changed to)
                  return delta.changed.prop[key];
                }
              }
            }
          }
        }
      }
    }

    this.pbvs = function _pbvs(){
      var pbvs = [];
      if (currentTab(this)){
        // do we actually know the target tab already?  if yes, go ahead and paremterize that
        pbvs.push({type:"tab", value: originalTab(this)});
      }
      if (this.currentNode instanceof WebAutomationLanguage.NodeVariable && this.currentNode.getSource() === NodeSources.RELATIONEXTRACTOR){ // we only want to pbv for things that must already have been extracted by relation extractor
        //pbvs.push({type:"node", value: this.node});
        // crucial to make sure that selectedIndex for the select node gets updated
        // otherwise things don't change and it doesn't matter if change event is raised
        // what index was selected in the recording?
        var origVal = firstUpdateToProp(this.trace, "selectedIndex");
        var originalValDict = {property: "selectedIndex", value: origVal};
        pbvs.push({type:"property", value: originalValDict});
      }
      return pbvs;
    };

    this.args = function _args(environment){
      var args = [];
      args.push({type:"tab", value: currentTab(this)});
      if (this.currentNode instanceof WebAutomationLanguage.NodeVariable && this.currentNode.getSource() === NodeSources.RELATIONEXTRACTOR){ // we only want to pbv for things that must already have been extracted by relation extractor
        //args.push({type:"node", value: currentNodeXpath(this, environment)});
        // crucial to make sure that selectedIndex for the select node gets updated
        // otherwise things don't change and it doesn't matter if change event is raised

        // extract the correct selectedIndex from the xpath of the current option node
        var xpath = currentNodeXpath(this, environment);
        WALconsole.log("currentNodeXpath", xpath);
        var segments = xpath.split("[")
        var indexOfNextOption = segments[segments.length - 1].split("]")[0]; 
        indexOfNextOption = parseInt(indexOfNextOption);
        // our node-to-xpath converter starts counting at 1, but selectedIndex property starts counting at 0, so subtract one
        indexOfNextOption = indexOfNextOption - 1;
        var valDict = {property: "selectedIndex", value: indexOfNextOption};

        args.push({type:"property", value: valDict});
      }
      return args;
    };


    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      attachToPrevBlock(this.block, prevBlock);
      setWAL(this.block, this);
      return this.block;
    };

    this.getHelena = function _getHelena(){
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      fn2(this);
    };

    this.postReplayProcessing = function _postReplayProcessing(runObject, trace, temporaryStatementIdentifier){
      return;
    };
  };


  pub.NodeVariableUse = function _NodeVariableUse(scrapeStatement){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "variableUse");
    var varNameFieldName = 'varNameFieldName';
    var attributeFieldName = "attributeFieldName";
    this.nodeVar = null;
    this.attributeOption = AttributeOptions.TEXT; // by default, text
    if (scrapeStatement){
      this.nodeVar = scrapeStatement.currentNode;
      if (scrapeStatement.scrapeLink){
        this.attributeOption = AttributeOptions.LINK;
      }
    }

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      if (this.nodeVar){
        return [this.nodeVar.getName()];
      }
      else{
        return [""];
      }
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      // uses the program obj, so only makes sense if we have one
      if (!program){return;}
      addToolboxLabel(this.blocklyLabel);
      var handleVarChange = function(newVarName){
        if (this.sourceBlock_){
          console.log("updating node to ", newVarName);
          getWAL(this.sourceBlock_).nodeVar = getNodeVariableByName(newVarName);
        }
      };
      var handleAttributeChange = function(newAttribute){
        if (this.sourceBlock_){
          getWAL(this.sourceBlock_).attributeOption = newAttribute;
        }
      };
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          if (program){
            var varNamesDropDown = makeVariableNamesDropdown(program);
            var attributesDropDown = [["TEXT", AttributeOptions.TEXT],["LINK", AttributeOptions.LINK]];
            if (varNamesDropDown.length > 0){
              this.appendValueInput('NodeVariableUse')
                  .appendField(new Blockly.FieldDropdown(varNamesDropDown, handleVarChange), varNameFieldName)
                  
                  .appendField(new Blockly.FieldDropdown(attributesDropDown, handleAttributeChange), attributeFieldName)
                  
                  ;
              
              this.setOutput(true, 'NodeVariableUse');
              //this.setColour(25);
              this.setColour(298);
              // the following is an important pattern
              // this might be a new block, in which case searching for existing wal statement for the block with this block's id
              // will be pointless; but if init is being called because a block is being restored from the trashcan, then we have
              // to do this check or we'll overwrite the existing Helena stuff, which would lose important state
              // (in this case, the information about the node variable/what node it actually represents)
              var wal = getWAL(this);
              if (!wal){
                setWAL(this, new pub.NodeVariableUse());
                var name = varNamesDropDown[0][0];
                getWAL(this).nodeVar = getNodeVariableByName(name); // since this is what it'll show by default, better act as though that's true
                if (!getWAL(this).nodeVar){
                  WALconsole.warn("This issue requires support.  We should never have a nodevariableuse that has no nodevar.");
                }

                getWAL(this).attributeOption = AttributeOptions.TEXT;
                
              }
            }
          }
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      // nope!  this one doesn't attach to prev! attachToPrevBlock(this.block, prevBlock);
      setWAL(this.block, this);
      this.block.setFieldValue(this.nodeVar.getName(), varNameFieldName);
      
      this.block.setFieldValue(this.attributeOption, attributeFieldName);
      
      return this.block;
    };

    this.getHelena = function _getHelena(){
      return this;
    };

    this.getHelenaSeq = function _getHelenaSeq(){
      var inputSeq = getInputSeq(this.block, "NodeVariableUse");
      var fullSeq = [this].concat(inputSeq);
      return fullSeq;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      fn2(this);
    };

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      // just retrieve the val
      this.currentVal = runObject.environment.envLookup(this.nodeVar.getName());
    };

    this.getCurrentVal = function _getCurrentVal(){
      // remember!  currentval is an object with text, link, source url, xpath, that stuff
      // so if the val is being used, we have fto pull out just the text
      if (!this.currentVal){
        return "";
      }
      if (this.nodeVar.nodeSource === NodeSources.PARAMETER){
        // special case.  just return the val
        return this.currentVal;
      }
      else if (this.attributeOption === AttributeOptions.TEXT){
        // ok, it's a normal nodevar, an actual dom node representation
        return this.currentVal.text;
      }
      else if (this.attributeOption === AttributeOptions.LINK){
        return this.currentVal.link;
      }
      return "";
    };

    this.getAttribute = function _getAttribute(){
      for (var key in AttributeOptions){
        if (this.attributeOption === AttributeOptions[key]){
          return key;
        }
      }
      return "";
    };

    this.getCurrentNode = function _getCurrentNode(){
      if (this.nodeVar.nodeSource === NodeSources.PARAMETER){
        // special case.  we need a dictionary, but we only have text because we got this as a param
        return {text: this.currentVal};
      }
      return this.currentVal;
    };

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };


  pub.Number = function _Number(){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "num");
    var numberFieldName = 'numberFieldName';
    this.currentValue = null;

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      if (this.nodeVar){
        return [this.currentVal];
      }
      else{
        return [""];
      }
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      addToolboxLabel(this.blocklyLabel, "numbers");
      var defaultNum = 100;
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          var wal = getWAL(this);
          if (!wal){
            setWAL(this, new pub.Number());
          }

          var block = this;
          this.appendDummyInput()
              .appendField(new Blockly.FieldNumber(defaultNum, null, null, null, 
                function(newNum){getWAL(block).currentValue = newNum;}), numberFieldName);

          this.setOutput(true, 'number');
          this.setColour(25);
          getWAL(this).currentValue = defaultNum;
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      setWAL(this.block, this);
      if (this.currentValue){
        this.block.setFieldValue(this.currentValue, numberFieldName);
      }
      return this.block;
    };

    this.getHelena = function _getHelena(){
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      fn2(this);
    };

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      // it's just a constant.  no need to do anything
    };

    this.getCurrentVal = function _getCurrentVal(){
      return this.currentValue;
    };

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };

  pub.String = function _String(currString){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "string");
    var stringFieldName = 'stringFieldName';
    if (currString || currString === ""){
      this.currentValue = currString;
    }
    else{
      this.currentValue = "your text here";
    }

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      if (this.nodeVar){
        return [this.currentValue];
      }
      else{
        return [""];
      }
    };

    this.hasText = function _hasText(){
      if (this.currentValue.length < 1){
        return false;
      }
      return true;
    }

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      addToolboxLabel(this.blocklyLabel, "text");
      var text = this.currentValue;
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          var wal = getWAL(this);
          if (!wal){
            setWAL(this, new pub.String());
          }

          this.appendDummyInput()
              .appendField(new Blockly.FieldTextInput(text, 
                function(newStr){
                  getWAL(this.sourceBlock_).currentValue = newStr;
                }), stringFieldName);

          this.setOutput(true, 'string');
          this.setColour(25);
          getWAL(this).currentValue = text;
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(leftblock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      setWAL(this.block, this);
      if (this.currentValue){
        this.block.setFieldValue(this.currentValue, stringFieldName);
      }
      return this.block;
    };

    this.getHelena = function _getHelena(){
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      fn2(this);
    };

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      // constant, so no need to do anything
    };

    this.getCurrentVal = function _getCurrentVal(){
      return this.currentValue;
    };

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };

  var AttributeOptions = { // silly to use strings, I know, but it makes it easier to do the blockly dropdown
    TEXT: "1",
    LINK: "2"
  };

  pub.OutputRowStatement = function _OutputRowStatement(scrapeStatements){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "output");

    var doInitialize = scrapeStatements; // we will sometimes initialize with undefined, as when reviving a saved program

    this.initialize = function _initialize(){
      this.trace = []; // no extra work to do in r+r layer for this
      this.cleanTrace = [];
      this.scrapeStatements = [];
      this.variableUseNodes = [];
      for (var i = 0; i < scrapeStatements.length; i++){
        this.addAssociatedScrapeStatement(scrapeStatements[i]);
        this.variableUseNodes.push(new WebAutomationLanguage.NodeVariableUse(scrapeStatements[i]));
      }
      this.relations = [];
    }

    this.remove = function _remove(){
      this.parent.removeChild(this);
      for (var i = 0; i < this.scrapeStatements.length; i++){
        this.scrapeStatements[i].removeAssociatedOutputStatement(this);
      }
    }

    this.addAssociatedScrapeStatement = function _addAssociatedScrapeStatement(scrapeStatement){
      this.scrapeStatements.push(scrapeStatement);
      scrapeStatement.addAssociatedOutputStatement(this);
    }
    this.removeAssociatedScrapeStatement = function _removeAssociatedScrapeStatement(scrapeStatement){
      this.scrapeStatements = _.without(this.scrapeStatements, scrapeStatement);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      var textRelationRepLs = _.reduce(this.relations, function(acc,relation){return acc.concat(relation.scrapedColumnNames());}, []);
      var nodeRepLs = _.map(this.scrapeStatements, function(statement){return statement.currentNode.toString(true);});
      var allNames = textRelationRepLs.concat(nodeRepLs);
      WALconsole.log("outputRowStatement", textRelationRepLs, nodeRepLs);
      return ["addOutputRow(["+allNames.join(", ")+"])"];
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      addToolboxLabel(this.blocklyLabel);
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendValueInput('NodeVariableUse')
              .appendField("add dataset row that includes:");
          this.setColour(25);
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      attachToPrevBlock(this.block, prevBlock);
      setWAL(this.block, this);
      var priorBlock = this.block;
      for (var i = 0; i < this.variableUseNodes.length; i++){
        var vun = this.variableUseNodes[i];
        var block = vun.genBlocklyNode(this.block, workspace);
        attachInputToOutput(priorBlock, block);
        priorBlock = block;
      }
      return this.block;
    };

    this.getHelena = function _getHelena(){
      // update our list of variable nodes based on the current blockly situation
      var firstInput = this.block.getInput('NodeVariableUse');
      if (firstInput && firstInput.connection.targetBlock()){
        var wal = getWAL(firstInput.connection.targetBlock());
        if (wal.getHelena){
          var inputSeq = wal.getHelenaSeq();
          this.variableUseNodes = inputSeq; 
        }
        else{
          // right now the only thing we allow to be chained are the node variables
          // todo: make a proper way of making a list in a blockly block.  maybe it needs to be vertical?
          // in the meantime, you can make an additional output row that uses exactly one cell
          this.variableUseNodes = [firstInput];
        }
      }
      else{
        this.variableUseNodes = [];
      }
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      for (var i = 0; i < this.variableUseNodes.length; i++){
        var e = this.variableUseNodes[i];
        e.traverse(fn, fn2);
      }
      fn2(this);
    };

    this.pbvs = function _pbvs(){
      return [];
    };

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      if (relation instanceof WebAutomationLanguage.TextRelation){ // only for text relations!
        // the textrelation's own function for grabbing current texts will handle keeping track of whether a given col should be scraped
        // note that this currently doesn't handle well cases where multiple output statements would be trying to grab the contents of a textrelation...
        this.relations = _.union(this.relations, [relation]); // add relation if it's not already in there
        return relation.columns;
      }
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      this.relations = _.without(this.relations, relation);
    };
    this.args = function _args(environment){
      return [];
    };

    // todo: is this the best place for this?
    function textToMainpanelNodeRepresentation(text){
      return {
        text: text, 
        link: null, 
        xpath: null, 
        frame: null, 
        source_url: null,
        top_frame_source_url: null,
        date: null
      };
    }

    function convertTextArrayToArrayOfTextCells(textArray){
      var newCells = _.map(textArray, textToMainpanelNodeRepresentation);
      _.each(newCells, function(cell){cell.scraped_attribute = "TEXT";})
      return newCells;
    }

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      // we've 'executed' an output statement.  better send a new row to our output
      var cells = [];
      var nodeCells = [];

      // let's switch to using the nodeVariableUses that we keep
      for (var i = 0; i < this.variableUseNodes.length; i++){
        var vun = this.variableUseNodes[i];
        vun.run(runObject, rbbcontinuation, rbboptions);
        var v = vun.getCurrentVal();
        var n = _.clone(vun.getCurrentNode());
        if (!n){
          n = {}; // an empty cell for cases where we never found the relevant node, since must send a node dict to server to store result
        }
        n.scraped_attribute = this.variableUseNodes[i].getAttribute();
        cells.push(v);
        nodeCells.push(n);
      }

      // for now we're assuming we always want to show the number of iterations of each loop as the final columns
      var loopIterationCounterTexts = _.map(getLoopIterationCounters(this), function(i){return i.toString();});
      _.each(loopIterationCounterTexts, function(ic){cells.push(ic);});
      
      /*
      // todo: why are there undefined things in here!!!!????  get rid of them.  seriously, fix that
      cells = _.filter(cells, function(cell){return cell !== null && cell !== undefined;});
      */

      runObject.dataset.addRow(nodeCells);
      runObject.program.mostRecentRow = cells;

      var displayTextCells = _.map(cells, function(cell){if (!cell){return "EMPTY";} else {return cell;}});
      UIObject.addNewRowToOutput(runObject.tab, displayTextCells);
      UIObject.updateRowsSoFar(runObject.tab, runObject.dataset.fullDatasetLength);

      rbbcontinuation(rbboptions); // and carry on when done
    };

    if (doInitialize){
      this.initialize();
    }
  }

  /*
  Statements below here are no longer executed by Ringer but rather by their own run methods
  */

  pub.BackStatement = function _BackStatement(pageVarCurr, pageVarBack){
    Revival.addRevivalLabel(this);
    // setBlocklyLabel(this, "back");
    var backStatement = this;
    if (pageVarCurr){ // we will sometimes initialize with undefined, as when reviving a saved program
      this.pageVarCurr = pageVarCurr;
      this.pageVarBack = pageVarBack;
    }

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      // back statements are now invisible cleanup, not normal statements, so don't use the line below for now
      // return [this.pageVarBack.toString() + " = " + this.pageVarCurr.toString() + ".back()" ];
      return [];
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      // we don't display back presses for now
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      return null;
    };

    this.getHelena = function _getHelena(){
      // this should never be called, because should never be represented in blockly
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      fn2(this);
    };

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      WALconsole.log("run back statement");
  // if something went wrong, we won't have a pagevar tabid, ugh
  if (!this.pageVarCurr.currentTabId()){
      rbbcontinuation(rbboptions);
      return;
  }
  var pageVarTabId = this.pageVarCurr.currentTabId();
  this.pageVarCurr.clearCurrentTabId();

      // ok, the only thing we're doing right now is trying to run this back button, so the next time we see a tab ask for an id
      // it should be because of this -- yes, theoretically there could be a process we started earlier that *just* decided to load a new top-level page
      // but that should probably be rare.  todo: is that actually rare?
  var that = this;
      utilities.listenForMessageOnce("content", "mainpanel", "requestTabID", function _backListener(data){
        WALconsole.log("back completed");
        backStatement.pageVarBack.setCurrentTabId(pageVarTabId, function(){rbbcontinuation(rbboptions);});
      });

      // send a back message to pageVarCurr
      utilities.sendMessage("mainpanel", "content", "backButton", {}, null, null, [pageVarTabId]);
      // todo: is it enough to just send this message and hope all goes well, or do we need some kind of acknowledgement?
      // update pageVarBack to make sure it has the right tab associated

      // todo: if we've been pressing next or more button within this loop, we might have to press back button a bunch of times!  or we might not if they chose not to make it a new page!  how to resolve????
    };

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };

  pub.ClosePageStatement = function _ClosePageStatement(pageVarCurr){
    Revival.addRevivalLabel(this);
    // setBlocklyLabel(this, "close");
    if (pageVarCurr){ // we will sometimes initialize with undefined, as when reviving a saved program
      this.pageVarCurr = pageVarCurr;
    }
    var that = this;

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      // close statements are now invisible cleanup, not normal statements, so don't use the line below for now
      // return [this.pageVarCurr.toString() + ".close()" ];
      return [];
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      return;
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      // ok, we're not actually making a block
      return null;
    };

    this.getHelena = function _getHelena(){
      // this should never be called bc should never be represented in blockly
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      fn2(this);
    };

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      console.log("run close statement");
      WALconsole.log("run close statement");

      var tabId = this.pageVarCurr.currentTabId();
      if (tabId !== undefined && tabId !== null){
        console.log("ClosePageStatement run removing tab", this.pageVarCurr.currentTabId());

        // we want to remove the tab, but we should never do that if we actually mapped the wrong tab and this tab belongs somewhere else
        // todo: in future, prevent it from mapping the wrong tab in the first place!  might involve messing with ringer layer
        // but also with setCurrentTabId, but mostly I think with the ringer layer
        var that = this;
        var okToRemoveTab = _.reduce(runObject.program.pageVars, function(acc, pageVar){
          return acc && (pageVar.currentTabId() !== that.pageVarCurr.currentTabId() || pageVar === that.pageVarCurr);
        }, true);
        if (okToRemoveTab){
          var tabId = this.pageVarCurr.currentTabId();
          chrome.tabs.remove(tabId, function(){
            that.pageVarCurr.clearCurrentTabId();
            var portManger = ports; // the ringer portsmanager object
            portManger.removeTabInfo(tabId);
            rbbcontinuation(rbboptions);
          }); 
        }
        else{
    // it's still ok to clear current tab, but don't close it
    that.pageVarCurr.clearCurrentTabId();
          rbbcontinuation(rbboptions);
        }
      }
      else{
        WALconsole.log("Warning: trying to close tab for pageVar that didn't have a tab associated at the moment.  Can happen after continue statement.");
        rbbcontinuation(rbboptions);
      }
    };

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };

  pub.ContinueStatement = function _ContinueStatement(){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "continue");

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      return ["continue"];
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      addToolboxLabel(this.blocklyLabel);
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendDummyInput()
              .appendField("skip");
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
          this.setColour(25);
          var wal = getWAL(this);
          if (!wal){
            setWAL(this, new pub.ContinueStatement());
          }
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      attachToPrevBlock(this.block, prevBlock);
      setWAL(this.block, this);
      return this.block;
    };

    this.getHelena = function _getHelena(){
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      fn2(this);
    };

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      // fun stuff!  time to flip on the 'continue' flag in our continuations, which the for loop continuation will eventually consume and turn off
      rbboptions.skipMode = true;
      rbbcontinuation(rbboptions);
    };

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };

  pub.WaitStatement = function _WaitStatement(){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "wait");
    this.wait = 0;
    var waitFieldName = 'waitInSeconds';

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      return ["wait " + this.wait.toString() + " seconds"];
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      addToolboxLabel(this.blocklyLabel);
      var handleWaitChange = function(newWait){
        console.log("newWait", newWait);
        console.log("this", this);
        console.log("this.sourceBlock_", this.sourceBlock_);
        if (this.sourceBlock_){
          getWAL(this.sourceBlock_).wait = newWait;
        }
      };
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendDummyInput()
              .appendField("wait")
              .appendField(new Blockly.FieldNumber('0', 0, null, null, handleWaitChange), waitFieldName)
              .appendField("seconds");
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
          this.setColour(25);
          var wal = getWAL(this);
          if (!wal){
            setWAL(this, new pub.WaitStatement());
          }
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      attachToPrevBlock(this.block, prevBlock);
      setWAL(this.block, this);
      this.block.setFieldValue(this.wait, waitFieldName);
      return this.block;
    };

    this.getHelena = function _getHelena(){
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      fn2(this);
    };

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      // just wait a while, then call rbbcontinuation on rbboptions
      setTimeout(function(){
        rbbcontinuation(rbboptions);
      }, this.wait * 1000);
    };

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };

  pub.WaitUntilUserReadyStatement = function _WaitUntilUserReadyStatement(){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "waitUntilUserReady");

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      return ["wait until user ready"];
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      addToolboxLabel(this.blocklyLabel);
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendDummyInput()
              .appendField("wait until user presses 'ready' button");
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
          this.setColour(25);
          var wal = getWAL(this);
          if (!wal){
            setWAL(this, new pub.WaitUntilUserReadyStatement());
          }
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      attachToPrevBlock(this.block, prevBlock);
      setWAL(this.block, this);
      return this.block;
    };

    this.getHelena = function _getHelena(){
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      fn2(this);
    };

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      // throw up a dialog message that asks the user to tell us when they're ready
      // once they're ready, call the rbbcontinuation on rbboptions
      var dialogText = "This program had a 'wait until user is ready' statement, so go ahead and press the button below when you're ready.";
      UIObject.addDialog("Ready when you are!", dialogText, 
        {"Go Ahead": function _goAhead(){WALconsole.log("Go Ahead."); rbbcontinuation(rbboptions);}}
      );
    };

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };

  function say(thingToSay){
    var msg = new SpeechSynthesisUtterance(thingToSay);
    msg.voice = speechSynthesis.getVoices().filter(function(voice) { return voice.name == 'Google US English'; })[0];
    window.speechSynthesis.speak(msg);
  }

  pub.SayStatement = function _SayStatement(){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "say");
    this.textToSay = null;

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      return ["say " + this.textToSay];
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      addToolboxLabel(this.blocklyLabel);
      var handleTextToSayChange = function(newText){
        if (this.sourceBlock_){
          getWAL(this.sourceBlock_).textToSay = newText;
        }
      };
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendDummyInput()
              .appendField("say");
          this.appendValueInput("textToSay");
          this.setInputsInline(true);
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
          this.setColour(25);
          var wal = getWAL(this);
          if (!wal){
            setWAL(this, new pub.SayStatement());
          }
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      attachToPrevBlock(this.block, prevBlock);
      setWAL(this.block, this);

      if (this.textToSay){
        attachToInput(this.block, this.textToSay.genBlocklyNode(this.block, workspace), "textToSay");
      }

      return this.block;
    };

    this.getHelena = function _getHelena(){
      var textToSayBlock = this.block.getInput('textToSay').connection.targetBlock();
      if (textToSayBlock){
        this.textToSay = getWAL(textToSayBlock).getHelena();
      }
      else{
        this.textToSay = null;
      }
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);

      if (this.textToSay){
        this.textToSay.traverse(fn, fn2);
      }

      fn2(this);
    };

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      // say the thing, then call rbbcontinuation on rbboptions
      if (this.textToSay){
        this.textToSay.run(runObject, rbbcontinuation, rbboptions);
        console.log("saying", this.textToSay);
        say(this.textToSay.getCurrentVal());
      }
      rbbcontinuation(rbboptions);
    };

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };

  pub.IfStatement = function _IfStatement(bodyStatements){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "if");
    this.condition = null;

    if (bodyStatements){ // we will sometimes initialize with undefined, as when reviving a saved program
      this.updateChildStatements(bodyStatements);
    }

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.removeChild = function _removeChild(childStatement){
      this.bodyStatements = _.without(this.bodyStatements, childStatement);
    };
    this.removeChildren = function _removeChild(childStatements){
      this.bodyStatements = _.difference(this.bodyStatements, childStatements);
    };
    this.appendChild = function _appendChild(childStatement){
      var newChildStatements = this.bodyStatements;
      newChildStatements.push(childStatement);
      this.updateChildStatements(newChildStatements);
    };
    this.insertChild = function _appendChild(childStatement, index){
      var newChildStatements = this.bodyStatements;
      newChildStatements.splice(index, 0, childStatement);
      this.updateChildStatements(newChildStatements);
    };

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      return ["if"]; // todo: when we have the real if statements, do the right thing
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      addToolboxLabel(this.blocklyLabel);
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendValueInput('NodeVariableUse')
              .appendField("if");
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
          this.appendStatementInput("statements") // important for our processing that we always call this statements
              .setCheck(null)
              .appendField("do");
          this.setColour(25);

          var wal = getWAL(this);
          if (!wal){
            setWAL(this, new pub.IfStatement());
          }
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      attachToPrevBlock(this.block, prevBlock);

      // handle the condition
      if (this.condition){
        var cond = this.condition.genBlocklyNode(this.block, workspace);
        attachToInput(this.block, cond, "NodeVariableUse");
      }
      
      // handle the body statements
      var firstNestedBlock = helenaSeqToBlocklySeq(this.bodyStatements, workspace);
      attachNestedBlocksToWrapper(this.block, firstNestedBlock);

      setWAL(this.block, this);
      return this.block;
    };

    this.getHelena = function _getHelena(){
      // all well and good to have the things attached after this block, but also need the bodyStatements updated
      var firstNestedBlock = this.block.getInput('statements').connection.targetBlock();
      var helenaSequence = blocklySeqToHelenaSeq(firstNestedBlock);
      this.bodyStatements = helenaSequence;

      // ok, but we also want to update our own condition object
      var conditionBlocklyBlock = this.block.getInput('NodeVariableUse').connection.targetBlock();
      if (conditionBlocklyBlock){
        var conditionHelena = getWAL(conditionBlocklyBlock).getHelena();
        this.condition = conditionHelena;        
      }
      else{
        this.condition = null;
      }
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      if (this.condition){
        this.condition.traverse(fn, fn2);
      }
      for (var i = 0; i < this.bodyStatements.length; i++){
        this.bodyStatements[i].traverse(fn, fn2);
      }
      fn2(this);
    };

    this.updateChildStatements = function _updateChildStatements(newChildStatements){
      this.bodyStatements = newChildStatements;
      for (var i = 0; i < this.bodyStatements.length; i++){
        this.bodyStatements[i].parent = this;
      }
    };

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      // first thing first, run everything on which you depend
      this.condition.run(runObject, rbbcontinuation, rbboptions);
      if (this.condition.getCurrentVal()){
        // so basically all that's going to happen here is we'll go ahead and decide to run the bodyStatements of the if
        // statement before we go back to running what comes after the if
        // so....
        // runObject.program.runBasicBlock(runObject, entityScope.bodyStatements, rbbcontinuation, rbboptions);
        runObject.program.runBasicBlock(runObject, this.bodyStatements, rbbcontinuation, rbboptions);
      }
      else{
        // for now we don't have else body statements for our ifs, so we should just carry on with execution
        rbbcontinuation(rbboptions);
      }

    }
    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      // todo: once we have real conditions may need to do something here
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };


  pub.WhileStatement = function _WhileStatement(bodyStatements){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "while");
    this.condition = null;

    if (bodyStatements){ // we will sometimes initialize with undefined, as when reviving a saved program
      this.updateChildStatements(bodyStatements);
    }

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.removeChild = function _removeChild(childStatement){
      this.bodyStatements = _.without(this.bodyStatements, childStatement);
    };
    this.removeChildren = function _removeChild(childStatements){
      this.bodyStatements = _.difference(this.bodyStatements, childStatements);
    };
    this.appendChild = function _appendChild(childStatement){
      var newChildStatements = this.bodyStatements;
      newChildStatements.push(childStatement);
      this.updateChildStatements(newChildStatements);
    };
    this.insertChild = function _appendChild(childStatement, index){
      var newChildStatements = this.bodyStatements;
      newChildStatements.splice(index, 0, childStatement);
      this.updateChildStatements(newChildStatements);
    };

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      return ["while"];
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      addToolboxLabel(this.blocklyLabel);
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendValueInput('NodeVariableUse')
              .appendField("repeat while");
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
          this.appendStatementInput("statements") // important for our processing that we always call this statements
              .setCheck(null)
              .appendField("do");
          this.setColour(44);

          var wal = getWAL(this);
          if (!wal){
            setWAL(this, new pub.WhileStatement());
          }
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      attachToPrevBlock(this.block, prevBlock);

      // handle the condition
      if (this.condition){
        var cond = this.condition.genBlocklyNode(this.block, workspace);
        attachToInput(this.block, cond, "NodeVariableUse");
      }
      
      // handle the body statements
      var firstNestedBlock = helenaSeqToBlocklySeq(this.bodyStatements, workspace);
      attachNestedBlocksToWrapper(this.block, firstNestedBlock);

      setWAL(this.block, this);
      return this.block;
    };

    this.getHelena = function _getHelena(){
      // all well and good to have the things attached after this block, but also need the bodyStatements updated
      var firstNestedBlock = this.block.getInput('statements').connection.targetBlock();
      var helenaSequence = blocklySeqToHelenaSeq(firstNestedBlock);
      this.bodyStatements = helenaSequence;

      // ok, but we also want to update our own condition object
      var conditionBlocklyBlock = this.block.getInput('NodeVariableUse').connection.targetBlock();
      if (conditionBlocklyBlock){
        var conditionHelena = getWAL(conditionBlocklyBlock).getHelena();
        this.condition = conditionHelena;        
      }
      else{
        this.condition = null;
      }
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      if (this.condition){
        this.condition.traverse(fn, fn2);
      }
      for (var i = 0; i < this.bodyStatements.length; i++){
        this.bodyStatements[i].traverse(fn, fn2);
      }
      fn2(this);
    };

    this.updateChildStatements = function _updateChildStatements(newChildStatements){
      this.bodyStatements = newChildStatements;
      for (var i = 0; i < this.bodyStatements.length; i++){
        this.bodyStatements[i].parent = this;
      }
    };

    var statement = this;
    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      // first thing first, run everything on which you depend
      this.condition.run(runObject, rbbcontinuation, rbboptions);
      if (this.condition.getCurrentVal()){
        // so basically all that's going to happen here is we'll go ahead and decide to run the bodyStatements of the while
        // statement before we go back to running what comes after the while
        // so....
        // runObject.program.runBasicBlock(runObject, entityScope.bodyStatements, rbbcontinuation, rbboptions);

        // ok, what's the new continuation that will then repeat this while statement run function?
        // (remember, we've got to loop!)
        var newCont = function(){
          statement.run(runObject, rbbcontinuation, rbboptions);
        }

        runObject.program.runBasicBlock(runObject, this.bodyStatements, newCont, rbboptions);        
      }
      else{
        // for now we don't have else body statements for our ifs, so we should just carry on with execution
        rbbcontinuation(rbboptions);
      }

    }
    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      // todo: once we have real conditions may need to do something here
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };

  pub.BinOpNum = function _BinOpNum(){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "binopnum");
    this.left = null;
    this.right = null;
    this.operator = null;

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      return ["binopnum"];
    };

    var operators = {
       '>': function(a, b){ return a>b},
       '>=': function(a, b){ return a>=b},
       '==': function(a, b){ return a===b},
       '<': function(a, b){ return a<b},
       '<=': function(a, b){ return a<=b}
    };
    var handleOpChange = function(newOp){
        if (this.sourceBlock_ && getWAL(this.sourceBlock_)){
          getWAL(this.sourceBlock_).operator = newOp;
        }
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      var dropdown = makeOpsDropdown(operators);
      addToolboxLabel(this.blocklyLabel, "numbers");
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendValueInput("left");
          this.appendDummyInput().appendField(new Blockly.FieldDropdown(dropdown, handleOpChange), "op");
          this.appendValueInput("right");
          this.setInputsInline(true);
          this.setOutput(true, 'Bool');
          this.setColour(25);

          var wal = getWAL(this);
          if (!wal){
            setWAL(this, new pub.BinOpNum());
            var op = dropdown[0][0];
            getWAL(this).operator = op; // since this is what it'll show by default, better act as though that's true
          }
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      setWAL(this.block, this);
      this.block.setFieldValue(this.operator, "op");
      if (this.left){
        attachToInput(this.block, this.left.genBlocklyNode(this.block, workspace), "left");
      }
      if (this.right){
        attachToInput(this.block, this.right.genBlocklyNode(this.block, workspace), "right");
      }
      return this.block;
    };

    this.getHelena = function _getHelena(){
      // ok, but we also want to update our own condition object
      var leftBlock = this.block.getInput('left').connection.targetBlock();
      var rightBlock = this.block.getInput('right').connection.targetBlock();
      if (leftBlock){
        this.left = getWAL(leftBlock).getHelena();
      }
      else{
        this.left = null;
      }
      if (rightBlock){
        this.right = getWAL(rightBlock).getHelena();
      }
      else{
        this.right = null;
      }
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      if (this.left){this.left.traverse(fn, fn2);}
      if (this.right){ this.right.traverse(fn, fn2);}
      fn2(this);
    };

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      // now run the things on which we depend
      this.left.run(runObject, rbbcontinuation, rbboptions);
      this.right.run(runObject, rbbcontinuation, rbboptions);

      var leftVal = parseInt(this.left.getCurrentVal()); // todo: make this float not int
      var rightVal = parseInt(this.right.getCurrentVal());
      this.currentVal = operators[this.operator](leftVal, rightVal);
    };
    this.getCurrentVal = function _getCurrentVal(){
      return this.currentVal;
    };
    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };

  pub.BinOpString = function _BinOpString(){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "binopstring");
    this.left = null;
    this.right = null;
    this.operator = null;

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      return ["binopstring"];
    };

    var operators = {
       'contains': function(a, b){ return a.indexOf(b) > -1; },
       'is in': function(a, b){ return b.indexOf(a) > -1; },
       'is': function(a, b){ return a === b; }
    };
    var handleOpChange = function(newOp){
        if (this.sourceBlock_ && getWAL(this.sourceBlock_)){
          getWAL(this.sourceBlock_).operator = newOp;
        }
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      var dropdown = makeOpsDropdown(operators);
      addToolboxLabel(this.blocklyLabel, "text");
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendValueInput("left");
          this.appendDummyInput().appendField(new Blockly.FieldDropdown(dropdown, handleOpChange), "op");
          this.appendValueInput("right");
          this.setInputsInline(true);
          this.setOutput(true, 'Bool');
          this.setColour(25);

          var wal = getWAL(this);
          if (!wal){
            setWAL(this, new pub.BinOpString());
            var op = dropdown[0][0];
            getWAL(this).operator = op; // since this is what it'll show by default, better act as though that's true
          }
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      setWAL(this.block, this);
      this.block.setFieldValue(this.operator, "op");
      if (this.left){
        attachToInput(this.block, this.left.genBlocklyNode(this.block, workspace), "left");
      }
      if (this.right){
        attachToInput(this.block, this.right.genBlocklyNode(this.block, workspace), "right");
      }
      return this.block;
    };

    this.getHelena = function _getHelena(){
      // ok, but we also want to update our own condition object
      var leftBlock = this.block.getInput('left').connection.targetBlock();
      var rightBlock = this.block.getInput('right').connection.targetBlock();
      if (leftBlock){
        this.left = getWAL(leftBlock).getHelena();
      }
      else{
        this.left = null;
      }
      if (rightBlock){
        this.right = getWAL(rightBlock).getHelena();
      }
      else{
        this.right = null;
      }
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      if (this.left){this.left.traverse(fn, fn2);}
      if (this.right){ this.right.traverse(fn, fn2);}
      fn2(this);
    };

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      // now run the things on which we depend
      this.left.run(runObject, rbbcontinuation, rbboptions);
      this.right.run(runObject, rbbcontinuation, rbboptions);

      var leftVal = this.left.getCurrentVal(); // todo: make this float not int
      var rightVal = this.right.getCurrentVal();
      this.currentVal = operators[this.operator](leftVal, rightVal);
    };
    this.getCurrentVal = function _getCurrentVal(){
      return this.currentVal;
    };
    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };

  pub.LengthString = function _LengthString(){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "lengthstring");
    this.input = null;

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      return ["lengthstring"];
    };

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      addToolboxLabel(this.blocklyLabel, "text");
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendDummyInput()
              .appendField("length of");
          this.appendValueInput("input");
          this.setInputsInline(true);
          this.setOutput(true, 'Bool');
          this.setColour(25);

          var wal = getWAL(this);
          if (!wal){
            setWAL(this, new pub.LengthString());
          }
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      setWAL(this.block, this);
      if (this.input){
        attachToInput(this.block, this.input.genBlocklyNode(this.block, workspace), "input");
      }
      return this.block;
    };

    this.getHelena = function _getHelena(){
      // ok, but we also want to update our own condition object
      var inputBlock = this.block.getInput('input').connection.targetBlock();
      if (inputBlock){
        this.input = getWAL(inputBlock).getHelena();
      }
      else{
        this.input = null;
      }
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      if (this.input){this.input.traverse(fn, fn2);}
      fn2(this);
    };

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      // now run the things on which we depend
      this.input.run(runObject, rbbcontinuation, rbboptions);
      var inputVal = this.input.getCurrentVal();
      this.currentVal = inputVal.length;
    };
    this.getCurrentVal = function _getCurrentVal(){
      return this.currentVal;
    };
    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };

  var SkippingStrategies = {
    ALWAYS: "always",
    NEVER: "never",
    ONERUNLOGICAL: "onerunlogical",
    SOMETIMESPHYSICAL: "physical",
    SOMETIMESLOGICAL: "logical"
  };

  var duplicateAnnotationCounter = 0;
  // pub.skipblock pub.entityscope this is the thing that we actually officially call skip blocks
  pub.DuplicateAnnotation = function _EntityScope(annotationItems, availableAnnotationItems, bodyStatements){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "duplicate_annotation");

    var entityScope = this;

    this.initialize = function(){
      this.annotationItems = annotationItems;
      this.availableAnnotationItems = availableAnnotationItems;
      this.ancestorAnnotations = [];
      this.requiredAncestorAnnotations = []; // we're also allowed to require that prior annotations match, as well as our own annotationItems
      duplicateAnnotationCounter += 1;
      this.name = "Entity" + duplicateAnnotationCounter;
      this.dataset_specific_id = duplicateAnnotationCounter;
      this.updateChildStatements(bodyStatements);
      this.skippingStrategy = SkippingStrategies.ALWAYS; // by default, we'll skip if there's any duplicate in the history
    }

    this.remove = function _remove(){
      this.parent.removeChild(this);
    };

    this.removeChild = function _removeChild(childStatement){
      this.bodyStatements = _.without(this.bodyStatements, childStatement);
    };
    this.removeChildren = function _removeChild(childStatements){
      this.bodyStatements = _.difference(this.bodyStatements, childStatements);
    };
    this.appendChild = function _appendChild(childStatement){
      var newChildStatements = this.bodyStatements;
      newChildStatements.push(childStatement);
      this.updateChildStatements(newChildStatements);
    };
    this.insertChild = function _appendChild(childStatement, index){
      var newChildStatements = this.bodyStatements;
      newChildStatements.splice(index, 0, childStatement);
      this.updateChildStatements(newChildStatements);
    };

    this.updateChildStatements = function _updateChildStatements(newChildStatements){
      this.bodyStatements = newChildStatements;
      for (var i = 0; i < this.bodyStatements.length; i++){
        this.bodyStatements[i].parent = this;
      }
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      this.currentTransaction = null;
      this.duplicatesInARow = 0;
      return;
    }

    this.toStringLines = function _toStringLines(){
      var ancestorString = "";
      for (var i = 0; i < this.ancestorAnnotations.length; i++){
        ancestorString += ", " + this.ancestorAnnotations[i].name;
      }
      var annotationItemsStr = _.map(this.annotationItems, function(i){return annotationItemToString(i);}).join(", ");
      var prefix = "skipBlock("+this.name+"("+annotationItemsStr+")"+ancestorString+"){";
      var statementStrings = _.reduce(this.bodyStatements, function(acc, statement){return acc.concat(statement.toStringLines());}, []);
      statementStrings = _.map(statementStrings, function(line){return ("&nbsp&nbsp&nbsp&nbsp "+line);});
      return [prefix].concat(statementStrings).concat(["}"]);
    };

    function annotationItemToString(item){
      return item.nodeVar.toString() + "." + item.attr;
    }

    var color = 7;
    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
    };

    var TimeUnits = {
      YEARS: "years",
      MONTHS: "months",
      WEEKS: "weeks",
      DAYS: "days",
      HOURS: "hours",
      MINUTES: "minutes"
    }

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      var customBlocklyLabel = this.blocklyLabel + this.id;
      var name = this.name;
      var ancestorAnnotations = this.ancestorAnnotations;
      var requiredAncestorAnnotations = this.requiredAncestorAnnotations;
      var availableAnnotationItems = this.availableAnnotationItems;
      var annotationItems = this.annotationItems;
      console.log("in genBlocklyNode", this, this.name, ancestorAnnotations, requiredAncestorAnnotations);

      Blockly.Blocks[customBlocklyLabel] = {
        init: function() {
          console.log("in init", ancestorAnnotations, requiredAncestorAnnotations);
          var fieldsSoFar = this.appendDummyInput()
              .appendField("entity name: ")
              .appendField(new Blockly.FieldTextInput(name), "name");
          if (availableAnnotationItems.length > 0){
            fieldsSoFar = this.appendDummyInput().appendField("attributes:");
          }
          for (var i = 0; i < availableAnnotationItems.length; i++){
            var onNow = annotationItems.indexOf(availableAnnotationItems[i]) > -1;
            onNow = MiscUtilities.toBlocklyBoolString(onNow);
            var extra = "";
            if (i > 0){
              extra = ",  ";
            }
            var toggleItemUse = null;
            (function(){
              var ai = availableAnnotationItems[i];
              toggleItemUse = function(){
                var ind = annotationItems.indexOf(ai);
                if (ind >= 0){
                  annotationItems.splice(ind, 1);
                }
                else{
                  annotationItems.push(ai);
                }
              }
            })();
            fieldsSoFar = fieldsSoFar.appendField(extra + annotationItemToString(availableAnnotationItems[i]) + ":")
            .appendField(new Blockly.FieldCheckbox(onNow, toggleItemUse), annotationItemToString(availableAnnotationItems[i]));
          }
          if (ancestorAnnotations.length > 0){
            fieldsSoFar = this.appendDummyInput().appendField("other entitites: ");
          }
          for (var i = 0; i < ancestorAnnotations.length; i++){
            var onNow = requiredAncestorAnnotations.indexOf(ancestorAnnotations[i]) > -1;
            onNow = MiscUtilities.toBlocklyBoolString(onNow);
            fieldsSoFar = fieldsSoFar.appendField(ancestorAnnotations[i].name + ":")
            .appendField(new Blockly.FieldCheckbox(onNow), ancestorAnnotations[i].name);
          }

          // ok, time to let the user decide on the skipping strategy

          fieldsSoFar = this.appendDummyInput().appendField("When should we skip an item? ");
          var skippingOptions = ["Never skip, even if it's a duplicate.", 
          "Skip if we've ever scraped a duplicate.", 
          "Skip if we scraped a duplicate in the same run.", 
          "Skip if we scraped a duplicate in the last", 
          "Skip if we scraped a duplicate in the last"];
          var skippingStrategies = [SkippingStrategies.NEVER, SkippingStrategies.ALWAYS, SkippingStrategies.ONERUNLOGICAL, SkippingStrategies.SOMETIMESLOGICAL, SkippingStrategies.SOMETIMESPHYSICAL];
          
          var that = this;
          var allSkippingStrategyCheckboxes = [];
          var skippingStrategyChangeHandler = function(skippingStrategy){
            console.log(skippingStrategy);
            if (that.getFieldValue(skippingStrategy) === MiscUtilities.toBlocklyBoolString(false)){
              // if it's been turned off till now, it's on now, so go ahead and set the skipping strategy
              console.log("turned on", that.getFieldValue(skippingStrategy));
              entityScope.skippingStrategy = skippingStrategy;
            }
            for (var j = 0; j < allSkippingStrategyCheckboxes.length; j++){
              var checkboxName = allSkippingStrategyCheckboxes[j];
              if (checkboxName === skippingStrategy){
                continue;
              }
              that.setFieldValue(MiscUtilities.toBlocklyBoolString(false), checkboxName);
            }
          }
          for (var i = 0; i < skippingOptions.length; i++){
            (function(){
              var thisSkippingStrategy = skippingStrategies[i];
              var onNow = entityScope.skippingStrategy === skippingStrategies[i];
              onNow = MiscUtilities.toBlocklyBoolString(onNow);
              allSkippingStrategyCheckboxes.push(thisSkippingStrategy);
              fieldsSoFar = that.appendDummyInput().appendField(
                new Blockly.FieldCheckbox(onNow, function(){skippingStrategyChangeHandler(thisSkippingStrategy)}), thisSkippingStrategy);
              fieldsSoFar = fieldsSoFar.appendField(skippingOptions[i]);
              if (i === 3){
                var curLogicalTime = entityScope.logicalTime;
                if (curLogicalTime !== 0 && !curLogicalTime){ curLogicalTime = 1; }
                console.log("curLogicalTime", curLogicalTime);
                var logicalTimeFieldName = "logicalTime";
                var textInput = new Blockly.FieldTextInput(curLogicalTime.toString(), function(){
                  Blockly.FieldTextInput.numberValidator(); 
                  entityScope.logicalTime = parseInt(that.getFieldValue(logicalTimeFieldName));});
                fieldsSoFar = fieldsSoFar.appendField(textInput, logicalTimeFieldName).appendField(" runs.");
                if (entityScope.logicalTime !== 0 && !entityScope.logicalTime){entityScope.logicalTime = 1;}
              }
              if (i === 4){
                var curPhysicalTime = entityScope.physicalTime;
                if (curPhysicalTime !== 0 && !curPhysicalTime){ curPhysicalTime = 1; }
                console.log("curPhysicalTime", curPhysicalTime);
                var physicalTimeFieldName = "physicalTime";
                var textInput = new Blockly.FieldTextInput(curPhysicalTime.toString(), function(){
                  Blockly.FieldTextInput.numberValidator(); 
                  entityScope.physicalTime = parseInt(that.getFieldValue(physicalTimeFieldName));});
                fieldsSoFar = fieldsSoFar.appendField(textInput, physicalTimeFieldName);

                var options = [];
                for (var key in TimeUnits){
                  options.push([TimeUnits[key], TimeUnits[key]]);
                }
                // here we actually set the entityScope's time unit, since no guarantee the user will interact with that pulldown and trigger the setting, but we have to show something, so want what we show to match with prog representation
                if (!entityScope.physicalTimeUnit){entityScope.physicalTimeUnit = TimeUnits.YEARS;}
                if (entityScope.physicalTime !== 0 && !entityScope.physicalTime){entityScope.physicalTime = 1;}
                var timeUnitsFieldName = "timeunits";
                fieldsSoFar = fieldsSoFar.appendField(new Blockly.FieldDropdown(options, function(newVal){entityScope.physicalTimeUnit = newVal; console.log(entityScope.physicalTimeUnit);}), timeUnitsFieldName);
                fieldsSoFar = fieldsSoFar.appendField(".");
                that.setFieldValue(entityScope.physicalTimeUnit, timeUnitsFieldName); // set it to the current time unit
              }
            })();
          }


          this.appendStatementInput("statements") // must be called this
              .setCheck(null)
              .appendField("do");
          
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
          this.setColour(color);
        },
        onchange: function(ev) {
            var newName = this.getFieldValue("name");
            if (newName !== getWAL(this).name){
              getWAL(this).name = newName;
            }
        }
      };
      this.block = workspace.newBlock(customBlocklyLabel);
      attachToPrevBlock(this.block, prevBlock);

      // handle the body statements
      var firstNestedBlock = helenaSeqToBlocklySeq(this.bodyStatements, workspace);
      attachNestedBlocksToWrapper(this.block, firstNestedBlock);

      setWAL(this.block, this);
      return this.block;
    };

    this.getHelena = function _getHelena(){
      // all well and good to have the things attached after this block, but also need the bodyStatements updated
      var firstNestedBlock = this.block.getInput('statements').connection.targetBlock();
      var seq = blocklySeqToHelenaSeq(firstNestedBlock);
      this.bodyStatements = seq;
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      for (var i = 0; i < this.bodyStatements.length; i++){
        this.bodyStatements[i].traverse(fn, fn2);
      }
      fn2(this);
    };

    this.endOfLoopCleanup = function _endOfLoopCleanup(continuation){
      this.currentTransaction = null;
      this.duplicatesInARow = 0;
    };

    function hash(str){
      // from https://github.com/darkskyapp/string-hash
      // The hashing function returns a number between 0 and 4294967295 (inclusive).

      var hash = 5381;
      var i = str.length;

      while(i) {
        hash = (hash * 33) ^ str.charCodeAt(--i);
      }

      /* JavaScript does bitwise operations (like XOR, above) on 32-bit signed
       * integers. Since we want the results to be always positive, convert the
       * signed int to an unsigned by doing an unsigned bitshift. */
      return hash >>> 0;
    }

    function transactionToHash(currentTransaction){
      var transactionStr = "";
      for (var i = 0; i < currentTransaction.length; i++){
        transactionStr += "_" + currentTransaction[i].attr + "___" + currentTransaction[i].val;
      }
      var h = hash(transactionStr);
      WALconsole.log(transactionStr, h);
      return h;
    }

    function isThisMyWorkBasedOnHash(currentTransaction, hashBasedParallelObject){
      var numThreads = hashBasedParallelObject.numThreads;
      var thisThreadIndex = hashBasedParallelObject.thisThreadIndex;
      var h = transactionToHash(currentTransaction);
      // The hashing function returns a number between 0 and 4294967295 (inclusive)
      var limitLow = (thisThreadIndex / numThreads) * 4294967295;
      var limitHigh = ((thisThreadIndex + 1) / numThreads) * 4294967295;
      if (h >= limitLow && h <= limitHigh){
        return true;
      }
      return false;
    }

    // for testing only!  no reason to actually use this!
    var bins = {};
    function bin(currentTransaction){
      var lim = 8;
      for (var i = 0; i < lim; i++){
        var res = isThisMyWorkBasedOnHash(currentTransaction, {numThreads: lim, thisThreadIndex: i});
        if (res){
          if (i in bins){
            bins[i] = bins[i] + 1;
          }
          else{
            bins[i] = 1;
          }
        }
      }
      console.log("bins", bins);
    }

    this.currentTransaction = null;
    this.duplicatesInARow = 0; // make sure to set this to 0 at the beginning of a loop!
    this.run = function _run(runObject, rbbcontinuation, rbboptions){

      if (rbboptions.ignoreEntityScope || this.skippingStrategy === SkippingStrategies.NEVER){
        // this is the case where we just want to assume there's no duplicate because we're pretending the annotation isn't there
        // or we have the never-skip strategy on
        // or we're in hashBasedParallel mode and the hash tells us it's not our work
        runObject.program.runBasicBlock(runObject, entityScope.bodyStatements, rbbcontinuation, rbboptions);
        return;
      }

      // if we're not ignoring entityscope, we're in the case where choice depends on whether there's a saved duplicate on server
      this.currentTransaction = this.singleAnnotationItems(runObject.environment);

      var inParallelMode = rbboptions.parallel;

      // let's check if we're divvying work up based on hashes
      if (rbboptions.hashBasedParallel && rbboptions.hashBasedParallel.on){
        if (!isThisMyWorkBasedOnHash(this.currentTransaction, rbboptions.hashBasedParallel)){
          // this isn't our responsibility in any case.  no need to talk to server.  just skip
          rbbcontinuation(rbboptions);
          return; // very important to return after the skip
        }
        else{
          // ok, let's just fall back into treating it like normal parallel mode
          inParallelMode = true;
        }
      }

      // this is where we should switch to checking if the current task has been locked/claimed if we're in parallel mode
      var targetUrl = helenaServerUrl+'/transactionexists';
      if (inParallelMode){
        targetUrl = helenaServerUrl+'/locktransaction';
        if (this.descendIntoLocks){
          // this one's a weird case.  in this case, we're actually re-entering a skip block already locked by another worker
          // because it has descendant work that we can help with and because we want good load balancing
          targetUrl = helenaServerUrl+'/takeblockduringdescent';
        }
      }

      // you only need to talk to the server if you're actually going to act (skip) now on the knowledge of the duplicate
      var msg = this.serverTransactionRepresentationCheck(runObject);
      MiscUtilities.postAndRePostOnFailure(targetUrl, msg, function(resp){
        if (resp.exists || resp.task_yours === false){
          // this is a duplicate, current loop iteration already done, so we're ready to skip to the next
          // so actually nothing should happen.  the whole entityscope should be a no-op
          entityScope.duplicatesInARow += 1;
          WALconsole.namedLog("duplicates", "new duplicate", entityScope.duplicatesInARow);
          if (rbboptions.breakAfterXDuplicatesInARow && entityScope.duplicatesInARow >= rbboptions.breakAfterXDuplicatesInARow){
            // ok, we're actually in a special case, because not only are we not doing the body of the entityScope, we're actually breaking out of this loop
            rbboptions.breakMode = true;
          }
          rbbcontinuation(rbboptions);
        }
        else{
          entityScope.duplicatesInARow = 0;
          // no duplicate saved, so just carry on as usual
          runObject.program.runBasicBlock(runObject, entityScope.bodyStatements, function(){
            // and when we're done with processing the bodystatements, we'll want to commit
            // and then once we've committed, we can go ahead and do the original rbbcontinuation
            entityScope.commit(runObject, rbbcontinuation, rbboptions);
          }, rbboptions);
        }
      },true," to tell us if we should do this subtask");
    };

    this.commit = function _commit(runObject, rbbcontinuation, rbboptions){
      if (!rbboptions.skipCommitInThisIteration){ // it could be that something has happened that will cause us to skip any commits that happen in a particular loop iteration (no node that has all required features, for example)
        var transactionMsg = this.serverTransactionRepresentationCommit(runObject, new Date().getTime());
        var datasetSliceMsg = runObject.dataset.datasetSlice();
        var fullMsg = _.extend(transactionMsg, datasetSliceMsg);
        MiscUtilities.postAndRePostOnFailure(helenaServerUrl+'/newtransactionwithdata', fullMsg, function(){}, false);
      }
      rbbcontinuation(rbboptions);
    };

    this.singleAnnotationItems = function _singleAnnotationItems(environment){
      var rep = [];
      for (var i = 0; i < this.annotationItems.length; i++){
        var item = this.annotationItems[i];
        var nodeVar = item.nodeVar;
        var val = null;
        if (item.attr === "TEXT"){
          val = nodeVar.currentText(environment);
        }
        else if (item.attr === "LINK") {
          val = nodeVar.currentLink(environment);
        }
        else { 
          WALconsole.warn("yo, we don't know what kind of attr we're looking for: ", item.attr);
        }
        rep.push({val:val, attr: item.attr});
      }
      return rep;
    }

    var multipliersForSeconds = {};
    multipliersForSeconds[TimeUnits.MINUTES] = 60;
    multipliersForSeconds[TimeUnits.HOURS] = multipliersForSeconds[TimeUnits.MINUTES] * 60;
    multipliersForSeconds[TimeUnits.DAYS] = multipliersForSeconds[TimeUnits.HOURS] * 24;
    multipliersForSeconds[TimeUnits.WEEKS] = multipliersForSeconds[TimeUnits.DAYS] * 7;
    multipliersForSeconds[TimeUnits.MONTHS] = 2628000;
    multipliersForSeconds[TimeUnits.YEARS] = multipliersForSeconds[TimeUnits.DAYS] * 365;
    this.serverTransactionRepresentation = function _serverRepresentation(runObject){
      var rep = [];
      // build up the whole set of attributes that we use to find a duplicate
      // some from this annotation, but some from any required ancestor annotations
      for (var i = 0; i < this.requiredAncestorAnnotations.length; i++){
        rep = rep.concat(this.requiredAncestorAnnotations[i].currentTransaction);
      }
      rep = rep.concat(this.currentTransaction);
      var rep = {program_run_id: runObject.dataset.getId(), program_id: runObject.program.id, transaction_attributes: encodeURIComponent(JSON.stringify(rep)), annotation_id: this.dataset_specific_id};
      return rep;
    };
    this.serverTransactionRepresentationCheck = function _serverTransactionRepresentationCheck(runObject, recencyConstraintOptions){
      var rep = this.serverTransactionRepresentation(runObject);
      var strat = this.skippingStrategy;
      if (strat === SkippingStrategies.ALWAYS){
        // actually don't need to do anything.  the default looks through the whole log and skips if there's any duplicate match
      }
      else if (strat === SkippingStrategies.ONERUNLOGICAL){
        rep.logical_time_diff = 0; // we're allowed to go back exactly 0 logical runs, must only reason about this logical run.
      }
      else if (strat === SkippingStrategies.SOMETIMESPHYSICAL){
        rep.physical_time_diff_seconds = this.physicalTime * multipliersForSeconds[this.physicalTimeUnit];
      }
      else if (strat === SkippingStrategies.SOMETIMESLOGICAL){
        rep.logical_time_diff = this.logicalTime; // the run id is already associated, so we only need to know how many back we're allowed to go
      }
      else{
        WALconsole.warn("Woah, there was a skipping strategy that we actually don't support: ", strat);
      }
      return rep;
    };
    this.serverTransactionRepresentationCommit = function _serverTransactionRepresentationCommit(runObject, commitTime){
      var rep = this.serverTransactionRepresentation(runObject);
      rep.commit_time = commitTime;
      return rep;
    };

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };

    if (annotationItems){
      this.initialize();
    }

  };


  /*
  Loop statements not executed by run method, although may ultimately want to refactor to that
  */

  pub.LoopStatement = function _LoopStatement(relation, relationColumnsUsed, bodyStatements, cleanupStatements, pageVar){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "loop");

    var doInitialization = bodyStatements;
    var loopStatement = this;
    this.cleanupStatements = [];

    this.initialize = function _initialize(){
      this.relation = relation;
      this.relationColumnsUsed = relationColumnsUsed;
      this.updateChildStatements(bodyStatements);
      this.pageVar = pageVar;
      this.maxRows = null; // note: for now, can only be sat at js console.  todo: eventually should have ui interaction for this.
      this.rowsSoFar = 0; 
      this.cleanupStatements = cleanupStatements;
    }

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }
    this.getChildren = function _getChildren(){
      return this.bodyStatements;
    }
    this.removeChild = function _removeChild(childStatement){
      this.bodyStatements = _.without(this.bodyStatements, childStatement);
    };
    this.removeChildren = function _removeChild(childStatements){
      this.bodyStatements = _.difference(this.bodyStatements, childStatements);
    };
    this.appendChild = function _appendChild(childStatement){
      var newChildStatements = this.bodyStatements;
      newChildStatements.push(childStatement);
      this.updateChildStatements(newChildStatements);
    };
    this.insertChild = function _insertChild(childStatement, index){
      var newChildStatements = this.bodyStatements;
      newChildStatements.splice(index, 0, childStatement);
      this.updateChildStatements(newChildStatements);
    };

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      this.rowsSoFar = 0;
      return;
    }

    this.toStringLines = function _toStringLines(){
      var relation = this.relation;
      var varNames = this.relation.scrapedColumnNames();
      var additionalVarNames = this.relation.columnName(this.relationColumnUsed);
      varNames = _.union(varNames, additionalVarNames);
      WALconsole.log("loopstatement", varNames, additionalVarNames);
      var prefix = "";
      if (this.relation instanceof WebAutomationLanguage.TextRelation){
        var prefix = "for ("+varNames.join(", ")+" in "+this.relation.name+"){"; 
      }
      else{
        var prefix = "for ("+varNames.join(", ")+" in "+this.pageVar.toString()+"."+this.relation.name+"){"; 
      }
      var statementStrings = _.reduce(this.bodyStatements, function(acc, statement){return acc.concat(statement.toStringLines());}, []);
      statementStrings = _.map(statementStrings, function(line){return ("&nbsp&nbsp&nbsp&nbsp "+line);});
      return [prefix].concat(statementStrings).concat(["}"]);
    };

    function defined(v){
      return (v !== null && v !== undefined);
    }

    var maxRowsFieldName = "maxRows";
    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      // uses the program obj, so only makes sense if we have one
      if (!program){return;}
      if (relations.length < 1){
        WALconsole.log("no relations yet, so can't have any loops in blockly.");
        return;
      }

      var handleMaxRowsChange = function(newMaxRows){
        if (this.sourceBlock_ && getWAL(this.sourceBlock_)){
          getWAL(this.sourceBlock_).maxRows = newMaxRows;
          // if you changed the maxRows and it's actually defined, should make sure the max rows actually used...
          if (defined(newMaxRows)){
            dontUseInfiniteRows.bind(this)();
          }
        }
      };
      var useInfiniteRows = function(){
        var block = this.sourceBlock_;
        setTimeout(function(){
          block.setFieldValue("TRUE", "infiniteRowsCheckbox");
          block.setFieldValue("FALSE", "limitedRowsCheckbox");
        }, 0);
        getWAL(block).maxRows = null;
      };
      var dontUseInfiniteRows = function(){
        var block = this.sourceBlock_;
        setTimeout(function(){
          block.setFieldValue("FALSE", "infiniteRowsCheckbox");
          block.setFieldValue("TRUE", "limitedRowsCheckbox");
        }, 0);
        getWAL(block).maxRows = this.sourceBlock_.getFieldValue(maxRowsFieldName);
      }

      var handleNewRelationName = function(){
        var block = this.sourceBlock_;
        // getWAL(block).maxRows = this.sourceBlock_.getFieldValue(maxRowsFieldName);
        var newName = this.sourceBlock_.getFieldValue("relationName");
        var WALrep = getWAL(block);
        if (WALrep){
          setTimeout(function(){
            var relObj = WALrep.relation;
            relObj.name = newName;
            //UIObject.updateDisplayedScript();
            UIObject.updateDisplayedScript(false); // update without updating how blockly appears
            UIObject.updateDisplayedRelations();
          },0);
        }
      }

      // addToolboxLabel(this.blocklyLabel);
      var pageVarsDropDown = makePageVarsDropdown(pageVars);
      var statement = this;
      var startName = "relation_name";
      if (statement && statement.relation && statement.relation.name){
        startName = statement.relation.name;
      }
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          var soFar = this.appendDummyInput()
              .appendField("for each row in")
              .appendField(new Blockly.FieldTextInput(startName, handleNewRelationName), "relationName")      
              .appendField("in")
              .appendField(new Blockly.FieldDropdown(pageVarsDropDown), "page");  
               
              if (!demoMode){
                soFar.appendField("(")
                .appendField(new Blockly.FieldCheckbox("TRUE", useInfiniteRows), 'infiniteRowsCheckbox')
                .appendField("for all rows,")
                .appendField(new Blockly.FieldCheckbox("TRUE", dontUseInfiniteRows), 'limitedRowsCheckbox')
                .appendField("for the first")
                .appendField(new Blockly.FieldNumber(20, 0, null, null, handleMaxRowsChange), maxRowsFieldName)      
                .appendField("rows)");
              }
          this.appendStatementInput("statements") // important for our processing that we always call this statements
              .setCheck(null)
              .appendField("do");
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
          this.setColour(44);
          this.setTooltip('');
          this.setHelpUrl('');
        },
        onchange: function(ev) {
          if (ev instanceof Blockly.Events.Ui){
            if (ev.element === "selected" && ev.oldValue === this.id){ // unselected
              // remember that if this block was selected, relation names may have changed.  so we should re-display everything
              UIObject.updateDisplayedScript(true);
            }
          }
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      this.block.setFieldValue(this.relation.name, "relationName");
      if (this.pageVar){
        this.block.setFieldValue(this.pageVar.toString(), "page");
      }
      
      if (!demoMode){
        if (this.maxRows){
          this.block.setFieldValue(this.maxRows, maxRowsFieldName);
          this.block.setFieldValue("FALSE", "infiniteRowsCheckbox");
        }
        else{
          // we're using infinite rows
          this.block.setFieldValue("FALSE", "limitedRowsCheckbox");
        }
      }
      
      attachToPrevBlock(this.block, prevBlock);

      // handle the body statements
      var firstNestedBlock = helenaSeqToBlocklySeq(this.bodyStatements, workspace);
      attachNestedBlocksToWrapper(this.block, firstNestedBlock);

      setWAL(this.block, this);
      return this.block;
    };

    this.getHelena = function _getHelena(){
      // all well and good to have the things attached after this block, but also need the bodyStatements updated
      var firstNestedBlock = this.block.getInput('statements').connection.targetBlock();
      var nested = blocklySeqToHelenaSeq(firstNestedBlock);
      this.bodyStatements = nested;
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      for (var i = 0; i < this.bodyStatements.length; i++){
        this.bodyStatements[i].traverse(fn, fn2);
      }
      fn2(this);
    };

    function adjustAnnotationParents(currProg){
      // go through the whole tree and make sure any nested annotations know all ancestor annotations
      // note that by default we're making all of them required for matches, not just available for matches
      // in future, if user has edited, we might want to let those edits stand...
      var ancestorAnnotations = [];
      currProg.traverse(function(statement){
        if (statement instanceof WebAutomationLanguage.DuplicateAnnotation){
          statement.ancestorAnnotations = ancestorAnnotations.slice();
          statement.requiredAncestorAnnotations = ancestorAnnotations.slice();
          ancestorAnnotations.push(statement);
        }
      },
      function(statement){
        if (statement instanceof WebAutomationLanguage.DuplicateAnnotation){
          // back out of this entity scope again, so pop it off
          ancestorAnnotations = _.without(ancestorAnnotations, statement);
        }
      });
    }

    function insertAnnotation(annotationItems, availableAnnotationItems, index, currProg){
      var loopBodyStatements = loopStatement.bodyStatements;
      var bodyStatements = loopBodyStatements.slice(index, loopBodyStatements.length);
      var annotation = new WebAutomationLanguage.DuplicateAnnotation(annotationItems, availableAnnotationItems, bodyStatements);
      loopStatement.removeChildren(bodyStatements); // now that they're the entityScope's children, shouldn't be loop's children anymore
      loopStatement.appendChild(annotation);
      adjustAnnotationParents(currProg);
      UIObject.updateDisplayedScript();
    }

    this.addAnnotation = function _addAnnotation(annotationItems, availableAnnotationItems, currProg){
      console.log("annotationItems", annotationItems);
      var notYetDefinedAnnotationItems = _.uniq(_.map(annotationItems.slice(), function(obj){return obj.nodeVar;})); // if have both text and link, may appear multiple times
      var alreadyDefinedAnnotationItems = this.relationNodeVariables();
      notYetDefinedAnnotationItems = _.difference(notYetDefinedAnnotationItems, alreadyDefinedAnnotationItems);
      if (notYetDefinedAnnotationItems.length <= 0){
        insertAnnotation(annotationItems, availableAnnotationItems, 0, currProg);
        return;
      }
      for (var i = 0; i < this.bodyStatements.length; i++){
        var bStatement = this.bodyStatements[i];
        if (bStatement instanceof WebAutomationLanguage.ScrapeStatement){
          notYetDefinedAnnotationItems = _.without(notYetDefinedAnnotationItems, _.findWhere(notYetDefinedAnnotationItems, {nodeVar:bStatement.currentNode}));
        }
        if (notYetDefinedAnnotationItems.length <= 0){
          insertAnnotation(annotationItems, availableAnnotationItems, i + 1, currProg);
          return;
        }
      }
    };

    this.relationNodeVariables = function _relationNodeVariables(){
      return this.relation.nodeVariables();
    }
    this.updateRelationNodeVariables = function _updateRelationNodeVariables(environment){
      WALconsole.log("updateRelationNodeVariables");
      this.relation.updateNodeVariables(environment, this.pageVar);
    }

    this.updateChildStatements = function _updateChildStatements(newChildStatements){
      this.bodyStatements = newChildStatements;
      for (var i = 0; i < this.bodyStatements.length; i++){
        this.bodyStatements[i].parent = this;
      }
    }

    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return _.flatten(_.map(this.bodyStatements, function(statement){
        return statement.parameterizeForRelation(relation);}));
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      _.each(this.bodyStatements, function(statement){statement.unParameterizeForRelation(relation);});
    };

    this.endOfLoopCleanup = function _endOfLoopCleanup(continuation){
      if (this.relation.endOfLoopCleanup){
        this.relation.endOfLoopCleanup(this.pageVar, continuation);
      }
      else{
        continuation();
      }
    }

    if (doInitialization){
      this.initialize();
    }

  }

  function usedByTextStatement(statement, parameterizeableStrings){
    if (!parameterizeableStrings){
      return false;
    }
    if (!(statement instanceof WebAutomationLanguage.TypeStatement || statement instanceof WebAutomationLanguage.LoadStatement)){
      return false;
    }
    for (var i = 0; i < parameterizeableStrings.length; i++){
      if (!parameterizeableStrings[i]){ continue;}
      var lowerString = parameterizeableStrings[i].toLowerCase();
      if (statement.typedStringLower && statement.typedStringLower.indexOf(lowerString) > -1){ // for typestatement
        return true;
      }
      if (statement.cUrl){
        var currURL = statement.cUrl();
        if (currURL && urlMatch(currURL.toLowerCase(), lowerString)) { // for loadstatement
          return true;
        }
      }
    }
    return false;
  }

  // used for relations that only have text in cells, as when user uploads the relation
  pub.TextRelation = function _TextRelation(csvFileContents, name){
    Revival.addRevivalLabel(this);
    var doInitialization = csvFileContents;
    if (doInitialization){ // we will sometimes initialize with undefined, as when reviving a saved program
      this.relation = $.csv.toArrays(csvFileContents);
      this.firstRowTexts = this.relation[0];
      if (name){
        this.name = name;
      }
    }

    this.scrapedColumnNames = function _scrapedColumnNames(){
      return _.map(_.filter(this.columns, function(colObj){return colObj.scraped;}), function(colObj){return colObj.name;});
    };

    this.columnName = function _columnName(colObj){
      return _.map(colObj, function(colObj){return colObj.name;});
    };
    this.columnNames = function _columnNames(){
      return _.map(this.columns, function(colObj){return colObj.name;});
    };

    this.demonstrationTimeRelationText = function _demonstrationTimeRelationText(){
      return this.relation;
    }

    this.firstRowNodeRepresentations = function _firstRowNodeRepresentations(){
      var toNodeRep = function(text){
        return {text: text};
      }
      var firstRowTexts = this.relation[0];
      return _.map(firstRowTexts, toNodeRep);
    };

    this.firstRowNodeRepresentation = function _firstRowNodeRepresentation(colObj){
      var firstRow = this.firstRowNodeRepresentations();
      return firstRow[colObj.index];
    };

    this.nodeVariables = function _nodeVariables(){
      var firstRowNodeReps = this.firstRowNodeRepresentations();
      if (!this.nodeVars || this.nodeVars.length < 1){
        this.nodeVars = [];
        for (var i = 0; i < this.columns.length; i++){
          this.nodeVars.push(new WebAutomationLanguage.NodeVariable(this.columns[i].name, firstRowNodeReps[i], null, null, NodeSources.TEXTRELATION));
        }
      }
      return this.nodeVars;
    }

    this.updateNodeVariables = function _updateNodeVariables(environment, pageVar){
      WALconsole.log("updateNodeVariables TextRelation");
      var nodeVariables = this.nodeVariables();
      var columns = this.columns; // again, nodeVariables and columns must be aligned
      for (var i = 0; i < nodeVariables.length; i++){
        var text = this.relation[currentRowsCounter][columns[i].index];
        var currNodeRep = {text: text};
        nodeVariables[i].setCurrentNodeRep(environment, currNodeRep);
      }
    }

    this.columns = [];
    this.processColumns = function _processColumns(){
      for (var i = 0; i < this.relation[0].length; i++){
        this.columns.push({index: i, name: "column_"+i, firstRowXpath: null, xpath: null, firstRowText: this.firstRowTexts[i], // todo: don't actually want to put filler here
          scraped: true}); // by default, assume we want to scrape all of a text relation's cols (or else, why are they even here?)
      }
    };
    if (doInitialization){
      this.processColumns();
      this.nodeVariables(); // call this so that we make all of the node variables we'll need
    }

    this.getColumnObjectFromXpath = function _getColumnObjectFromXpath(xpath){
      for (var i = 0; i < this.columns.length; i++){
        if (this.columns[i].xpath === xpath){
          return this.columns[i];
        }
      }
      WALconsole.log("Ack!  No column object for that xpath: ", this.columns, xpath);
      return null;
    };

    // user can give us better names
    this.setColumnName = function _setColumnName(columnObj, v){
      columnObj.name = v;
      var nodeVariables = this.nodeVariables();
      nodeVariables[columnObj.index].setName(v);
      UIObject.updateDisplayedScript();
    };

    this.usedByStatement = function _usedByStatement(statement){
      return usedByTextStatement(statement, this.relation[0]);
    };

    var currentRowsCounter = -1;

    this.getNextRow = function _getNextRow(runObject, pageVar, callback){ // has to be called on a page, to match the signature for the non-text relations, but we'll ignore the pagevar
      if (currentRowsCounter + 1 >= this.relation.length){
        callback(false); // no more rows -- let the callback know we're done
      }
      else{
        currentRowsCounter += 1;
        callback(true);
      }
    };


    this.getCurrentCellsText = function _getCurrentCellsText(){
      var cells = [];
      for (var i = 0; i < this.columns.length; i++){
        if (this.columns[i].scraped){
          var cellText = this.getCurrentText(this.columns[i]);
          cells.push(cellText);
        }
      }
      return cells;
    };

    this.getCurrentText = function _getCurrentText(columnObject){
      WALconsole.log(currentRowsCounter, "currentRowsCounter");
      return this.relation[currentRowsCounter][columnObject.index];
    };

    this.getCurrentLink = function _getCurrentLink(pageVar, columnObject){
      WALconsole.log("yo, why are you trying to get a link from a text relation???");
      return "";
    };

    this.clearRunningState = function _clearRunningState(){
      currentRowsCounter = -1;
    };

    this.setRelationContents = function _setRelationContents(relationContents){
      this.relation = relationContents;
    }
    this.getRelationContents = function _getRelationContents(){
      return this.relation;
    }
  }

  var relationCounter = 0;
  pub.Relation = function _Relation(relationId, name, selector, selectorVersion, excludeFirst, columns, demonstrationTimeRelation, numRowsInDemo, pageVarName, url, nextType, nextButtonSelector, frame){
    Revival.addRevivalLabel(this);
    var doInitialization = selector;
    if (doInitialization){ // we will sometimes initialize with undefined, as when reviving a saved program
      this.id = relationId;
      this.selector = selector;
      this.selectorVersion = selectorVersion;
      this.excludeFirst = excludeFirst;
      this.columns = columns;
      this.demonstrationTimeRelation = demonstrationTimeRelation;
      this.numRowsInDemo = numRowsInDemo;
      this.pageVarName = pageVarName;
      this.url = url;
      this.nextType = nextType;
      this.nextButtonSelector = nextButtonSelector;
      this.frame = frame; // note that right now this frame comes from our relation-finding stage.  might want it to come from record
      if (name === undefined || name === null){
        relationCounter += 1;
        this.name = "list_"+relationCounter;
      }
      else{
        this.name = name;
      }
    }

    var relation = this;

    this.demonstrationTimeRelationText = function _demonstrationTimeRelationText(){
      return _.map(this.demonstrationTimeRelation, function(row){return _.map(row, function(cell){return cell.text;});});
    };

    this.firstRowNodeRepresentations = function _firstRowNodeRepresentations(){
      return this.demonstrationTimeRelation[0];
    };

    this.firstRowNodeRepresentation = function _firstRowNodeRepresentation(colObj){
      var allNodeReps = this.firstRowNodeRepresentations();
      var index = colObj.index; // must be agreement between demosntrationtimerelation indexes and actual colobject indexes
      return allNodeReps[index];
    };

    this.nodeVariables = function _NodeVariables(){
      if (!this.nodeVars || this.nodeVars.length < 1){
        this.nodeVars = [];
        var nodeReps = this.firstRowNodeRepresentations();
        for (var i = 0; i < nodeReps.length; i++){
          console.log(i);
          var name = this.columns[i].name;
          this.nodeVars.push(new WebAutomationLanguage.NodeVariable(name, nodeReps[i], null, null, NodeSources.RELATIONEXTRACTOR));
        }
      }
      return this.nodeVars;
    }

    this.updateNodeVariables = function _updateNodeVariables(environment, pageVar){
      WALconsole.log("updateNodeVariables Relation");
      var nodeVariables = this.nodeVariables();
      var columns = this.columns; // again, nodeVariables and columns must be aligned
      for (var i = 0; i < columns.length; i++){
        var currNodeRep = this.getCurrentNodeRep(pageVar, columns[i]);
        nodeVariables[i].setCurrentNodeRep(environment, currNodeRep);
      }
      WALconsole.log("updateNodeVariables Relation completed");
    }

    this.scrapedColumnNames = function _scrapedColumnNames(){
      return _.map(_.filter(this.columns, function(colObj){return colObj.scraped;}), function(colObj){return colObj.name;});
    };

    this.columnName = function _columnName(colObj){
      return _.map(colObj, function(colObj){return colObj.name;});
    };
    this.columnNames = function _columnNames(){
      return _.map(this.columns, function(colObj){return colObj.name;});
    };

    function domain(url){
      var domain = "";
      // don't need http and so on
      if (url.indexOf("://") > -1) {
          domain = url.split('/')[2];
      }
      else {
          domain = url.split('/')[0];
      }
      domain = domain.split(':')[0]; // there can be site.com:1234 and we don't want that
      return domain;
    }

    this.processColumns = function _processColumns(oldColumns){
      for (var i = 0; i < relation.columns.length; i++){
        processColumn(relation.columns[i], i, oldColumns); // should later look at whether this index is good enough
      }
    };

    function processColumn(colObject, index, oldColObjects){
      if (colObject.name === null || colObject.name === undefined){
        if (oldColObjects){
          // let's search the old col objects, see if any share an xpath and have a name for us
          var oldColObject = findByXpath(oldColObjects, colObject.xpath);
          colObject.name = oldColObject.name;
        }
        else{
          colObject.name = relation.name+"_item_"+(index+1); // a filler name that we'll use for now
        }
      }
      // let's keep track of whether it's scraped by the current program
      if (colObject.scraped === undefined){
        if (oldColObject){
          colObject.scraped = oldColObject.scraped;
        }
        else {
          colObject.scraped = false;
        }
      }
      if (relation.demonstrationTimeRelation[0]){
        var firstRowCell = findByXpath(relation.demonstrationTimeRelation[0], colObject.xpath); // for now we're aligning the demonstration items with everything else via xpath.  may not always be best
        if (!firstRowCell && colObject.xpath.toLowerCase().indexOf("/option[") > -1){
          // we're in the weird case where we interacted with a pulldown.  assume the options remain the same
          // even though we never recorded the option during record-time
          firstRowCell = relation.demonstrationTimeRelation[0][0]; // only one column for pulldown menus
        }
        if (firstRowCell){
          colObject.firstRowXpath = firstRowCell.xpath;
          colObject.firstRowText = firstRowCell.text;
          colObject.firstRowValue = firstRowCell.value;
        }
      }
      colObject.index = index;
    };

    if (doInitialization){
      WALconsole.log(this);
      this.processColumns();
    }

    function initialize(){
      relation.firstRowXPaths = _.pluck(relation.demonstrationTimeRelation[0], "xpath");
      relation.firstRowTexts = _.pluck(relation.demonstrationTimeRelation[0], "text");
      relation.firstRowValues = _.pluck(relation.demonstrationTimeRelation[0], "value");
    }
    
    if (doInitialization){
      initialize();
    }

    this.setNewAttributes = function _setNewAttributes(selector, selectorVersion, excludeFirst, columns, demonstrationTimeRelation, numRowsInDemo, nextType, nextButtonSelector){
      this.selector = selector;
      this.selectorVersion = selectorVersion;
      this.excludeFirst = excludeFirst;
      this.demonstrationTimeRelation = demonstrationTimeRelation;
      this.numRowsInDemo = numRowsInDemo;
      this.nextType = nextType;
      this.nextButtonSelector = nextButtonSelector;

      initialize();

      // now let's deal with columns.  recall we need the old ones, since they might have names we need
      var oldColumns = this.columns;
      this.columns = columns;
      this.processColumns(oldColumns);
    };

    function findByXpath(objectList, xpath){
      var objs = _.filter(objectList, function(obj){return obj.xpath === xpath;});
      if (objs.length === 0){ return null; }
      return objs[0];
    }

    this.nameColumnsAndRelation = function _nameColumnsAndRelation(){
      // should eventually consider looking at existing columns to suggest columns names
    }
    this.nameColumnsAndRelation();

    this.getColumnObjectFromXpath = function _getColumnObjectFromXpath(xpath){
      for (var i = 0; i < this.columns.length; i++){
        if (this.columns[i].xpath === xpath){
          return this.columns[i];
        }
      }
      WALconsole.log("Ack!  No column object for that xpath: ", this.columns, xpath);
      return null;
    };

    // user can give us better names
    this.setColumnName = function _setColumnName(columnObj, v){
      columnObj.name = v;
      var nodeVariables = this.nodeVariables();
      nodeVariables[columnObj.index].setName(v);
      UIObject.updateDisplayedScript();
    };

    function usedByPulldownStatement(statement, firstRowXPaths){
      if (statement instanceof WebAutomationLanguage.PulldownInteractionStatement){
        var xpath = statement.node;
        for (var i = 0; i < firstRowXPaths.length; i++){
          var cXpath = firstRowXPaths[i];
          if (cXpath.indexOf(xpath) > -1){ // so if the xpath of the pulldown menu appears in the xpath of the first row cell
            return true;
          }
        }
      }
      return false;
    }

    this.usedByStatement = function _usedByStatement(statement){
      if (!((statement instanceof WebAutomationLanguage.ScrapeStatement) || (statement instanceof WebAutomationLanguage.ClickStatement) || (statement instanceof WebAutomationLanguage.TypeStatement) || (statement instanceof WebAutomationLanguage.LoadStatement) || (statement instanceof WebAutomationLanguage.PulldownInteractionStatement))){
        return false;
      }
      if (statement.pageVar && this.pageVarName === statement.pageVar.name && this.firstRowXPaths && this.firstRowXPaths.indexOf(statement.node) > -1){
        return true;
      }
      if (usedByTextStatement(statement, this.firstRowTexts)){
        return true;
      }
      if (usedByPulldownStatement(statement, this.firstRowXPaths)){
        return true;
      }
      // ok, neither the node nor the typed text looks like this relation's cells
      return false;
    };

    this.messageRelationRepresentation = function _messageRelationRepresentation(){
      return {
        id: this.id, 
        name: this.name, 
        selector: this.selector, 
        selector_version: this.selectorVersion, 
        exclude_first: this.excludeFirst, 
        columns: this.columns, 
        next_type: this.nextType, 
        next_button_selector: this.nextButtonSelector, 
        url: this.url, 
        num_rows_in_demonstration: this.numRowsInDemo,
        relation_scrape_wait: this.relationScrapeWait
      };
    };

    this.getPrinfo = function _getPrinfo(pageVar){
      return pageVar.pageRelations[this.name+"_"+this.id];
    }
    this.setPrinfo = function _getPrinfo(pageVar, val){
      pageVar.pageRelations[this.name+"_"+this.id] = val;
    }

    this.noMoreRows = function _noMoreRows(runObject, pageVar, callback, allowMoreNextInteractions){
      // first let's see if we can try running the next interaction again to get some fresh stuff.  maybe that just didn't go through?
      var nextButtonAttemptsToAllowThreshold = runObject.program.nextButtonAttemptsThreshold;
      if (!nextButtonAttemptsToAllowThreshold){ nextButtonAttemptsToAllowThreshold = DefaultHelenaValues.nextButtonAttemptsThreshold;}
      var prinfo = this.getPrinfo(pageVar);
      if (allowMoreNextInteractions && prinfo.currentNextInteractionAttempts < nextButtonAttemptsToAllowThreshold){
        WALconsole.log("ok, we're going to try calling getNextRow again, running the next interaction again.  currentNextInteractionAttempts: "+prinfo.currentNextInteractionAttempts);
        prinfo.runNextInteraction = true; // so that we don't fall back into trying to grab rows from current page when what we really want is to run the next interaction again.
        this.getNextRow(runObject, pageVar, callback);
      }
      else{
        // no more rows -- let the callback know we're done
        // clear the stored relation data also
        prinfo.currentRows = null;
        WALconsole.namedLog("prinfo", "changing prinfo.currentrows, setting to null bc no more rows");
        WALconsole.namedLog("prinfo", shortPrintString(prinfo));
        prinfo.currentRowsCounter = 0;
        prinfo.currentNextInteractionAttempts = 0;
        callback(false); 
      }
    };

    this.gotMoreRows = function _gotMoreRows(pageVar, callback, rel){
      var prinfo = this.getPrinfo(pageVar);
      prinfo.needNewRows = false; // so that we don't fall back into this same case even though we now have the items we want
      prinfo.currentRows = rel;
      WALconsole.namedLog("prinfo", "changing prinfo.currentrows, setting to rel bc found more rows", rel);
      WALconsole.namedLog("prinfo", shortPrintString(prinfo));
      prinfo.currentRowsCounter = 0;
      prinfo.currentNextInteractionAttempts = 0;
      callback(true);
    }

    function highestPercentOfHasXpathPerRow(relation, limitToSearch){
      if (relation.length < limitToSearch) {limitToSearch = relation.length;}
      var maxWithXpathsPercent = 0;
      for (var i = 0; i < limitToSearch; i++){
        var numWithXpaths = _.reduce(relation[i], function(acc, cell){if (cell.xpath) {return acc + 1;} else {return acc}}, 0);
        var percentWithXpaths = numWithXpaths / relation[i].length;
        if (percentWithXpaths > maxWithXpathsPercent){
          maxWithXpathsPercent = percentWithXpaths;
        }
      }
      return maxWithXpathsPercent;
    }

    var getRowsCounter = 0;
    var doneArray = [];
    var relationItemsRetrieved = {};
    var missesSoFar = {}; // may still be interesting to track misses.  may choose to send an extra next button press, something like that
    // the function that we'll call when we actually have to go back to a page for freshRelationItems
    function getRowsFromPageVar(runObject, pageVar, callback){

      if (!pageVar.currentTabId()){ WALconsole.warn("Hey!  How'd you end up trying to find a relation on a page for which you don't have a current tab id??  That doesn't make sense.", pageVar); }
  
      getRowsCounter += 1;
      doneArray.push(false);
      // once we've gotten data from any frame, this is the function we'll call to process all the results
      var handleNewRelationItemsFromFrame = function(data, frameId){
        var currentGetRowsCounter = getRowsCounter;
        if (doneArray[currentGetRowsCounter]){
          return;
        }

        if (relationItemsRetrieved[frameId]){
          // we actually already have data from this frame.  this can happen because pages are still updating what they're showing
          // but it's a bit of a concern.  let's see what the data actually is, 
          // todo: we should make sure we're not totally losing data because of
          // overwriting old data with new data, then only processing the new data...
          WALconsole.namedLog("getRelationItems", "Got data from a frame for which we already have data", getRowsCounter);
          WALconsole.namedLog("getRelationItems", _.isEqual(data, relationItemsRetrieved[frameId]), data, relationItemsRetrieved[frameId]);
          // we definitely don't want to clobber real new items with anything that's not new items, so let's make sure we don't
          if (relationItemsRetrieved[frameId].type === RelationItemsOutputs.NEWITEMS && data.type !== RelationItemsOutputs.NEWITEMS){
            return;
          }
          // we also don't want to clobber if the old data is actually longer than the new data...
          // if we have long data, it's a little weird that we wouldn't just have accepted it and moved on, but it does happen...
          if (relationItemsRetrieved[frameId].type === RelationItemsOutputs.NEWITEMS && data.type === RelationItemsOutputs.NEWITEMS && relationItemsRetrieved[frameId].relation.length > data.relation.length){
            WALconsole.namedLog("getRelationItems", "The new data is also new items, but it's shorter than the others, so we're actually going to throw it away for now.  May be something to change later.");
            return;
          }
        }

        WALconsole.log("data", data);
        if (data.type === RelationItemsOutputs.NOMOREITEMS){
          // NOMOREITEMS -> definitively out of items.  this frame says this relation is done
          relationItemsRetrieved[frameId] = data; // to stop us from continuing to ask for freshitems
          WALconsole.namedLog("getRelationItems", "We're giving up on asking for new items for one of ", Object.keys(relationItemsRetrieved).length, " frames. frameId: ", frameId, relationItemsRetrieved, missesSoFar);
        }
        else if (data.type === RelationItemsOutputs.NONEWITEMSYET || (data.type === RelationItemsOutputs.NEWITEMS && data.relation.length === 0)){
          // todo: currently if we get data but it's only 0 rows, it goes here.  is that just an unnecessary delay?  should we just believe that that's the final answer?
          missesSoFar[frameId] += 1;
          WALconsole.namedLog("getRelationItems", "adding a miss to our count", frameId, missesSoFar[frameId]);
        }
        else if (data.type === RelationItemsOutputs.NEWITEMS){
          // yay, we have real data!

          // ok, the content script is supposed to prevent us from getting the same thing that it already sent before
          // but to be on the safe side, let's put in some extra protections so we don't try to advance too early
          // and also so we don't get into a case where we keep getting the same thing over and over and should decide we're done but instead loop forever
          
          function extractUserVisibleAttributesFromRelation(rel){
            return _.map(rel, function(row){ return _.map(row, function(d){return [d.text, d.link];})});
          }

          var prinfo = relation.getPrinfo(pageVar);

          if (prinfo.currentRows && _.isEqual(extractUserVisibleAttributesFromRelation(prinfo.currentRows), 
                                              extractUserVisibleAttributesFromRelation(data.relation))){
            WALconsole.namedLog("getRelationItems", "This really shouldn't happen.  We got the same relation back from the content script that we'd already gotten.");
            WALconsole.namedLog("getRelationItems", prinfo.currentRows);
            missesSoFar[frameId] += 1;
          }
          else{
            WALconsole.log("The relations are different.");
            WALconsole.log(prinfo.currentRows, data.relation);
            WALconsole.namedLog("getRelationItems", currentGetRowsCounter, data.relation.length);

            relationItemsRetrieved[frameId] = data; // to stop us from continuing to ask for freshitems

            // let's see if this one has xpaths for all of a row in the first few
            var aRowWithAllXpaths = highestPercentOfHasXpathPerRow(data.relation, 20) === 1;
            // and then see if the difference between the num rows and the target num rows is less than 90% of the target num rows 
            var targetNumRows = relation.demonstrationTimeRelation.length;
            var diffPercent = Math.abs(data.relation.length - targetNumRows) / targetNumRows;
            
            // only want to do the below if we've decided this is the actual data...
            // if this is the only frame, then it's definitely the data
            if (Object.keys(relationItemsRetrieved).length == 1 || (aRowWithAllXpaths && diffPercent < .9 )){
              doneArray[getRowsCounter] = true;
              relation.gotMoreRows(pageVar, callback, data.relation);
              return;
            }
          }
        }
        else{
          WALconsole.log("woaaaaaah freak out, there's freshRelationItems that have an unknown type.");
        }

        // so?  are we done?  if all frames indicated that there are no more, then we just need to stop because the page tried using a next button,
        // couldn't find one, and just won't be getting us more data
        var stillPossibleMoreItems = false; // this should be the value if all frames said NOMOREITEMS
        for (var key in relationItemsRetrieved){
          var obj = relationItemsRetrieved[key];
          if (!obj || obj.type !== RelationItemsOutputs.NOMOREITEMS){
            // ok, there's some reason to think it might be ok, so let's actually go ahead and try again
            stillPossibleMoreItems = true;
          }
        }
        if (!stillPossibleMoreItems){
          WALconsole.namedLog("getRelationItems", "all frames say we're done", getRowsCounter);
          doneArray[getRowsCounter] = true;
          relation.noMoreRows(runObject, pageVar, callback, false); // false because shouldn't try pressing the next button
        }
        else{
          WALconsole.namedLog("getRelationItems", "we think we might still get rows based on some frames not responding yet");
        }

      };

      function processEndOfCurrentGetRows(pageVar, callback){
        WALconsole.namedLog("getRelationItems", "processEndOfCurrentGetRows", getRowsCounter);
        // ok, we have 'real' (NEWITEMS or decided we're done) data for all of them, we won't be getting anything new, better just pick the best one
        doneArray[getRowsCounter] = true;
        var dataObjs = _.map(Object.keys(relationItemsRetrieved), function(key){return relationItemsRetrieved[key];});
        var dataObjsFiltered = _.filter(dataObjs, function(data){return data.type === RelationItemsOutputs.NEWITEMS;});
        // ok, let's see whether any is close in length to our original one. otherwise have to give up
        // how should we decide whether to accept something close or to believe it's just done???

        for (var i = 0; i < dataObjsFiltered.length; i++){
          var data = dataObjsFiltered[i];
          // let's see if this one has xpaths for all of a row in the first few
          var percentColumns = highestPercentOfHasXpathPerRow(data.relation, 20);
          // and then see if the difference between the num rows and the target num rows is less than 20% of the target num rows 
          var targetNumRows = relation.demonstrationTimeRelation.length;
          var diffPercent = Math.abs(data.relation.length - targetNumRows) / targetNumRows;
          if (percentColumns > .5 && diffPercent < .3){
            WALconsole.namedLog("getRelationItems", "all defined and found new items", getRowsCounter);
            doneArray[getRowsCounter] = true;
            relation.gotMoreRows(pageVar, callback, data.relation);
            return;
          }
        }

        // drat, even with our more flexible requirements, still didn't find one that works.  guess we're done?

        WALconsole.namedLog("getRelationItems", "all defined and couldn't find any relation items from any frames", getRowsCounter);
        doneArray[getRowsCounter] = true;
        relation.noMoreRows(runObject, pageVar, callback, true); // true because should allow trying the next button
      }

      // let's go ask all the frames to give us relation items for the relation
      var tabId = pageVar.currentTabId();
      WALconsole.log("pageVar.currentTabId()", pageVar.currentTabId());

      function requestFreshRelationItems(frames){
        var currentGetRowsCounter = getRowsCounter;
        relationItemsRetrieved = {};
        missesSoFar = {};
        frames.forEach(function(frame){
          // keep track of which frames need to respond before we'll be ready to advance
          relationItemsRetrieved[frame] = false;
          missesSoFar[frame] = 0;
        });
        frames.forEach(function(frame) {
          // for each frame in the target tab, we want to see if the frame retrieves good relation items
          // we'll pick the one we like best
          // todo: is there a better way?  after all, we do know the frame in which the user interacted with the first page at original record-time.  if we have next stuff happening, we might even know the exact frameId on this exact page
          
          // here's the function for sending the message once
          var msg = relation.messageRelationRepresentation();
          msg.msgType = "getFreshRelationItems";
          var sendGetRelationItems = function(){
            WALconsole.namedLog("getRelationItems", "requesting relation items", currentGetRowsCounter);
            utilities.sendFrameSpecificMessage("mainpanel", "content", "getFreshRelationItems", 
                                                relation.messageRelationRepresentation(), 
                                                tabId, frame, 
                                                // question: is it ok to insist that every single frame returns a non-null one?  maybe have a timeout?  maybe accept once we have at least one good response from one of the frames?
                                                function _getRelationItemsHandler(response) { 
                                                  WALconsole.namedLog("getRelationItems", "Receiving response: ", frame, response); 
                                                  WALconsole.namedLog("getRelationItems", "getFreshRelationItems answer", response);
                                                  if (response !== null && response !== undefined) {handleNewRelationItemsFromFrame(response, frame);}}); // when get response, call handleNewRelationItemsFromFrame (defined above) to pick from the frames' answers
          };
          // here's the function for sending the message until we decide we're done with the current attempt to get new rows, or until actually get the answer
          MiscUtilities.repeatUntil(sendGetRelationItems, function _checkDone(){return doneArray[currentGetRowsCounter] || relationItemsRetrieved[frame];},function(){}, 1000, true);
        });
        // and let's make sure that after our chosen timeout, we'll stop and just process whatever we have
        var desiredTimeout = runObject.program.relationFindingTimeoutThreshold;
        if (!desiredTimeout){ desiredTimeout = DefaultHelenaValues.relationFindingTimeoutThreshold;} // todo: this timeout should be configurable by the user, relation seconds timeout
        setTimeout(
          function _reachedTimeoutHandler(){
            WALconsole.namedLog("getRelationItems", "REACHED TIMEOUT, giving up on currentGetRows", currentGetRowsCounter);
            if (!doneArray[currentGetRowsCounter]){
              doneArray[currentGetRowsCounter] = false;
              processEndOfCurrentGetRows(pageVar, callback);
            }
          },
          desiredTimeout
        );
      };

      // if we're trying to get relation items from a page, we should have it visible
      chrome.tabs.update(tabId, {selected: true});

      // ok, let's figure out whether to send the message to all frames in the tab or only the top frame
      if (relation.frame === 0){
        // for now, it's only when the frame index is 0, meaning it's the top-level frame, that we decide on using a single frame ahead of time
        var frames = [0];
        requestFreshRelationItems(frames);
      }
      else {
        chrome.webNavigation.getAllFrames({tabId: tabId}, function(details) {
          var frames = _.map(details, function(d){return d.frameId;});
          requestFreshRelationItems(frames);
        });
      }

    }

    this.endOfLoopCleanup = function _endOfLoopCleanup(pageVar, continuation){
      // if we're not closing this page and we want to iterate through this relation again, it's critical
      // that we clear out all the stuff that's stored about the relation now
      var gotAck = false;
      utilities.listenForMessageOnce("content", "mainpanel", "clearedRelationInfo", function _clearRelationInfoAck(data){
        gotAck = true;
        continuation();
        });

      var currentTabId = pageVar.currentTabId();
      var sendTheMsg = function(){
        utilities.sendMessage("mainpanel", "content", "clearRelationInfo", relation.messageRelationRepresentation(), null, null, [currentTabId]);
      };
      if (currentTabId){
        MiscUtilities.repeatUntil(sendTheMsg, function(){return gotAck;},function(){}, 1000, false);
      }
      else{
        continuation();
      }
    }


    var getNextRowCounter = 0;
    var currNextButtonText = null; // for next buttons that are actually counting (page 1, 2, 3...), it's useful to keep track of this
    this.getNextRow = function _getNextRow(runObject, pageVar, callback){ // has to be called on a page, since a relation selector can be applied to many pages.  higher-level tool must control where to apply

      // ok, what's the page info on which we're manipulating this relation?
      WALconsole.log(pageVar.pageRelations);
      var prinfo = this.getPrinfo(pageVar); // separate relations can have same name (no rule against that) and same id (undefined if not yet saved to server), but since we assign unique names when not saved to server and unique ides when saved to server, should be rare to have same both.  todo: be more secure in future
      WALconsole.namedLog("prinfo", "change prinfo, finding it for getnextrow", this.name, this.id);
      WALconsole.namedLog("prinfo", shortPrintString(prinfo));
      if (prinfo === undefined){ // if we haven't seen the frame currently associated with this pagevar, need to clear our state and start fresh
        prinfo = {currentRows: null, currentRowsCounter: 0, currentTabId: pageVar.currentTabId(), currentNextInteractionAttempts: 0};
        this.setPrinfo(pageVar, prinfo);
        WALconsole.namedLog("prinfo", "change prinfo, prinfo was undefined", this.name, this.id);
        WALconsole.namedLog("prinfo", shortPrintString(prinfo));
      }

      // now that we have the page info to manipulate, what do we need to do to get the next row?
      WALconsole.log("getnextrow", this, prinfo.currentRowsCounter);
      if ((prinfo.currentRows === null || prinfo.needNewRows) && !prinfo.runNextInteraction){
        // cool!  no data right now, so we have to go to the page and ask for some
        getRowsFromPageVar(runObject, pageVar, callback, prinfo);
      }
      else if ((prinfo.currentRows && prinfo.currentRowsCounter + 1 >= prinfo.currentRows.length) || prinfo.runNextInteraction){
        prinfo.runNextInteraction = false; // have to turn that flag back off so we don't fall back into here after running the next interaction
        getNextRowCounter += 1;
        // ok, we had some data but we've run out.  time to try running the next button interaction and see if we can retrieve some more

        // the one exception, the case where we don't even want to bother asking the page is if we already know
        // there's no next button, no way to get additional pages.  in that case, just know the loop is done
        // and call the callback with false as the moreRows argument
        if (this.nextType === NextTypes.NOMOREITEMS || (!this.nextButtonSelector && this.nextType !== NextTypes.SCROLLFORMORE )){
          callback(false);
          return;
        }

        // the function for continuing once we've done a next interaction
        var continueWithANewPage = function _continueWithANewPage(){
          // cool, and now let's start the process of retrieving fresh items by calling this function again
          prinfo.needNewRows = true;
          relation.getNextRow(runObject, pageVar, callback);
        };

        // here's what we want to do once we've actually clicked on the next button, more button, etc
        // essentially, we want to run getNextRow again, ready to grab new data from the page that's now been loaded or updated
        var stopRequestingNext = false;
        utilities.listenForMessageOnce("content", "mainpanel", "runningNextInteraction", function _nextInteractionAck(data){
          var currentGetNextRowCounter = getNextRowCounter;
          WALconsole.namedLog("getRelationItems", currentGetNextRowCounter, "got nextinteraction ack");
          prinfo.currentNextInteractionAttempts += 1;
          WALconsole.log("we've tried to run the get next interaction again, got an acknowledgment, so now we'll stop requesting next");
          stopRequestingNext = true;
          continueWithANewPage();
        });

        utilities.listenForMessageOnce("content", "mainpanel", "nextButtonText", function _nextButtonText(data){
          currNextButtonText = data.text;
        });


        // here's us telling the content script to take care of clicking on the next button, more button, etc
        if (!pageVar.currentTabId()){ WALconsole.log("Hey!  How'd you end up trying to click next button on a page for which you don't have a current tab id??  That doesn't make sense.", pageVar); }
        var timeWhenStartedRequestingNextInteraction = (new Date()).getTime();
        var relationFindingTimeout = 120000; // 2 minutes timeout for when we just try reloading the page; todo: is this something we even hit?
        var sendRunNextInteraction = function(){
          WALconsole.log("we're trying to send a next interaction again");
          var currTime = (new Date()).getTime();
          // let's check if we've hit our timeout
          if ((currTime - timeWhenStartedRequestingNextInteraction) > relationFindingTimeout){
            // ok, we've crossed the threshold time and the next button still didn't work.  let's try refreshing the tab
            WALconsole.log("we crossed the time out between when we started requesting the next interaction and now.  we're going to try refreshing");
            stopRequestingNext = true;

            function callb() {
                if (chrome.runtime.lastError) {
                    // drat.  tab doesn't actually even exist.  the only way we could continue is just restart from the beginning
                    // becuase this is a list page.  so we just don't know what else to do
                    console.log(chrome.runtime.lastError.message);
                    WALconsole.warn("No idea what to do, so we're breaking -- a list page just wasn't present, so didn't know what to do next.");
                    return;
                } else {
                    WALconsole.log("refreshing the page now.");
                    // Tab exists.  so we can try reloading it, see how it goes
                    chrome.tabs.reload(pageVar.currentTabId(), {}, function(){
                      // ok, good, it's reloaded.  ready to go on with normal processing as though this reloaded page is our new page
                      continueWithANewPage();
                    });
                }
            }
            chrome.tabs.get(pageVar.currentTabId(),callb);

          }
          // ok, haven't hit the timeout so just keep trying the next interaction
          var currentGetNextRowCounter = getNextRowCounter;
          WALconsole.namedLog("getRelationItems", currentGetNextRowCounter, "requestNext");
          var msg = relation.messageRelationRepresentation();
          msg.prior_next_button_text = currNextButtonText;
          utilities.sendMessage("mainpanel", "content", "runNextInteraction", msg, null, null, [pageVar.currentTabId()]);};
        MiscUtilities.repeatUntil(sendRunNextInteraction, function(){return stopRequestingNext;},function(){}, 17000, false);
      }
      else {
        // we still have local rows that we haven't used yet.  just advance the counter to change which is our current row
        // the easy case :)
        prinfo.currentRowsCounter += 1;
        callback(true);
      }
    }

    this.getCurrentNodeRep = function _getCurrentNodeRep(pageVar, columnObject){
      var prinfo = pageVar.pageRelations[this.name+"_"+this.id]
      WALconsole.namedLog("prinfo", "change prinfo, finding it for getCurrentNodeRep", this.name, this.id);
      WALconsole.namedLog("prinfo", shortPrintString(prinfo));
      if (prinfo === undefined){ WALconsole.log("Bad!  Shouldn't be calling getCurrentLink on a pageVar for which we haven't yet called getNextRow."); return null; }
      if (prinfo.currentRows === undefined) {WALconsole.log("Bad!  Shouldn't be calling getCurrentLink on a prinfo with no currentRows.", prinfo); return null;}
      if (prinfo.currentRows === null){
        WALconsole.namedLog("prinfo", "the bad state");
      }
      if (prinfo.currentRows[prinfo.currentRowsCounter] === undefined) {WALconsole.log("Bad!  Shouldn't be calling getCurrentLink on a prinfo with a currentRowsCounter that doesn't correspond to a row in currentRows.", prinfo); return null;}
      return prinfo.currentRows[prinfo.currentRowsCounter][columnObject.index]; // in the current row, value at the index associated with nodeName
    }

    this.saveToServer = function _saveToServer(){
      // sample: $($.post('http://localhost:3000/saverelation', { relation: {name: "test", url: "www.test2.com/test-test2", selector: "test2", selector_version: 1, num_rows_in_demonstration: 10}, columns: [{name: "col1", xpath: "a[1]/div[1]", suffix: "div[1]"}] } ));
      var rel = ServerTranslationUtilities.JSONifyRelation(this); // note that JSONifyRelation does stable stringification
      MiscUtilities.postAndRePostOnFailure(helenaServerUrl+'/saverelation', {relation: rel}, function(){}, false);
    }

    this.clearRunningState = function _clearRunningState(){
      // for relations retrieved from pages, all relation info is stored with pagevar variables, so don't need to do anything
    };
  }

  var NodeSources = {
    RELATIONEXTRACTOR: 1,
    RINGER: 2,
    PARAMETER: 3,
    TEXTRELATION: 4
  };

  var nodeVariablesCounter = 0;

  // below is not a dict because names can change, but could be refactored eventually

  var allNodeVariablesSeenSoFar = [];

  function getNodeVariableByName(name){
    for (var i = 0; i < allNodeVariablesSeenSoFar.length; i++){
      if (allNodeVariablesSeenSoFar[i].getName() === name){
        return allNodeVariablesSeenSoFar[i];
      }
    }
    WALconsole.warn("Woah, you tried to get a node variable by name and there wasn't one with that name");
  }

  pub.NodeVariable = function _NodeVariable(name, mainpanelRep, recordedNodeSnapshot, imgData, source){
    Revival.addRevivalLabel(this);

    // we need these defined right here because we're about to use them in initialization
    this.getName = function _getName(){
      if (this.___privateName___){
        return this.___privateName___;
      }
      if (this.name){
        return this.name; // this is here for backwards compatibility.
      }
      return this.___privateName___;
    };
    this.setName = function _setName(name){
      // don't set it to the original name unless nothing else has that name yet
      var otherNodeVariableWithThisName = getNodeVariableByName(name);
      if (!otherNodeVariableWithThisName){
        this.___privateName___ = name;
      }
      else{
        if (otherNodeVariableWithThisName === this){
          // we're renaming it to the same thing.  no need to do anything
          return;
        }
        this.setName("alt_" + name);
      }
    };

    if (source === NodeSources.PARAMETER){
      // special case, just give it a name and call it good, because this will be provided by the user (externally)
      this.setName(name);
      this.nodeSource = source;
      // and let's put this in our allNodeVariablesSeenSoFar record of all our nvs
      allNodeVariablesSeenSoFar.push(this);
    }

    // ok, node variables are a little weird, because we have a special interest in making sure that
    // every place where the same node is used in the script is also represented by the same object
    // in the prog (so that we can rename in one place and have it propogate all over the program, not
    // confuse the user into thinking a single node could be multiple)
    this.recordedNodeSnapshot = recordedNodeSnapshot;
    if (!recordedNodeSnapshot && mainpanelRep){
      // when we make a node variable based on a cell of a relation, we may not have access to the full node snapshot
      this.recordedNodeSnapshot = mainpanelRep;
    }
    // ok, but also sometimes we get the recorded snapshot, which records text in the textcontent field
    // but we'll want to reason about the text field
    // nope, the textContent can totally be different from text
    // have to just start recording textContent of all the relation-scraped nodes
    /*
    if (this.recordedNodeSnapshot && this.recordedNodeSnapshot.textContent){
      this.recordedNodeSnapshot.text = this.recordedNodeSnapshot.textContent;
    }
    */

    this.sameNode = function _sameNode(otherNodeVariable){
      var nr1 = this.recordedNodeSnapshot;
      var nr2 = otherNodeVariable.recordedNodeSnapshot;
      if (nr1.xpath === "" || nr2.xpath === ""){
        // don't return that things line up just because we failed to find a node.
        // it will make us try to redefine the same thing over and over, and we'll get errors from that
        return false;
      }
      var ans = nr1.xpath === nr2.xpath && nr1.source_url === nr2.source_url; // baseURI is the url on which the ndoe was found
      return ans;
    }

    /*-------------------
    Initializaiton stuff
    -------------------*/

    this.___privateName___ = null;

    if (this.recordedNodeSnapshot){ // go through here if they provided either a snapshot or a mainpanel rep
      // actually go through and compare to all prior nodes
      for (var i = 0; i < allNodeVariablesSeenSoFar.length; i++){
        if (source !== NodeSources.TEXTRELATION && this.sameNode(allNodeVariablesSeenSoFar[i])){
          // ok, we already have a node variable for representing this.  just return that
          var theRightNode = allNodeVariablesSeenSoFar[i];
          // first update all the attributes based on how we now want to use the node
          if (name) {theRightNode.setName(name);}
          if (mainpanelRep) {theRightNode.mainpanelRep = mainpanelRep;}
          if (source) {theRightNode.nodeSource = source;}
          if (recordedNodeSnapshot){ theRightNode.recordedNodeSnapshot = recordedNodeSnapshot; }
          if (imgData){ theRightNode.imgData = imgData; }
          return theRightNode;
        }
      }
      // ok, this is our first time seeing the node.  go ahead and build it in the normal way

      if (!name){
        nodeVariablesCounter += 1;
        name = "thing_" + nodeVariablesCounter;
      }

      this.setName(name);
      this.imgData = imgData;
      this.nodeSource = source;

      // and let's put this in our allNodeVariablesSeenSoFar record of all our nvs
      allNodeVariablesSeenSoFar.push(this);
    }

    if (allNodeVariablesSeenSoFar.indexOf(this) < 0){
      // ok, we're reconstructing a program, so we don't yet have this node variable in our
      // tracker of all node variables.  go ahead and add it
      allNodeVariablesSeenSoFar.push(this);
    }


    this.toString = function _toString(alreadyBound, pageVar){
      if (alreadyBound === undefined){ alreadyBound = true;} 
      if (alreadyBound){
        return this.getName();
      }
      return this.imgData;
    };

    this.recordTimeText = function _recordTimeText(){
      return this.recordedNodeSnapshot.text;
    };
    this.recordTimeLink = function _recordTimeLink(){
      return this.recordedNodeSnapshot.link;
    };
    this.recordTimeXPath = function _recordTimeXPath(){
      return this.recordedNodeSnapshot.xpath;
    };
    this.recordTimeSnapshot = function _recordTimeSnapshot(){
      return this.recordedNodeSnapshot;
    }

    this.setCurrentNodeRep = function _setCurrentNodeRep(environment, nodeRep){
      // todo: should be a better way to get env
      WALconsole.log("setCurrentNodeRep", this.getName(), nodeRep);
      environment.envBind(this.getName(), nodeRep);
    };

    this.currentNodeRep = function _currentNodeRep(environment){
      return _.clone(environment.envLookup(this.getName())); // don't want to let someone call this and start messing with the enviornment representation, so clone
    };

    this.currentText = function _currentText(environment){
      return this.currentNodeRep(environment).text;
    };
    this.currentLink = function _currentLink(environment){
      return this.currentNodeRep(environment).link;
    };
    this.currentXPath = function _currentXPath(environment){
      return this.currentNodeRep(environment).xpath;
    };

    this.setSource = function _setSource(src){
      this.nodeSource = src;
    };
    this.getSource = function _getSource(){
      return this.nodeSource;
    };

    this.requiredFeatures = [];
    this.getRequiredFeatures = function _getRequiredFeatures(){
      return this.requiredFeatures;
    };
    this.setRequiredFeatures = function _setRequiredFeatures(featureSet){
      this.requiredFeatures = featureSet;
    };
    this.requireFeature = function _requireFeature(feature){
      this.requiredFeatures.push(feature);
    };
    this.unrequireFeature = function _unrequireFeature(feature){
      this.requiredFeatures = _.without(this.requiredFeatures, feature);
    };
  };

  function outlier(sortedList, potentialItem){ // note that first arg should be SortedArray not just sorted array
    // for now, difficult to deal with...
    return false;
    if (sortedList.length <= 10) {
      // it's just too soon to know if this is an outlier...
      return false;
    }
    // generous q1, q3
    var q1 = sortedList.get(Math.floor((sortedList.length() / 4)));
    var q3 = sortedList.get(Math.ceil((sortedList.length() * (3 / 4))));
    var iqr = q3 - q1;

    //var minValue = q1 - iqr * 1.5;
    //var maxValue = q3 + iqr * 1.5;
    var minValue = q1 - iqr * 3;
    var maxValue = q3 + iqr * 3;
    WALconsole.log("**************");
    WALconsole.log(sortedList.array);
    WALconsole.log(q1, q3, iqr);
    WALconsole.log(minValue, maxValue);
    WALconsole.log("**************");
    if (potentialItem < minValue || potentialItem > maxValue){
      return true;
    }
    return false;
  }

  pub.PageVariable = function _PageVariable(name, recordTimeUrl){
    Revival.addRevivalLabel(this);

    if (name){ // will sometimes call with undefined, as for revival
      this.name = name;
      this.recordTimeUrl = recordTimeUrl;
      this.pageRelations = {};
      WALconsole.namedLog("prinfo", "fresh empty pageRelations");
    }

    var that = this;

    function freshPageStats(){
      return {numNodes: new SortedArray([])};
    }

    this.setRecordTimeFrameData = function _setRecordTimeFrameData(frameData){
      this.recordTimeFrameData = frameData;
    };

    this.setCurrentTabId = function _setCurrentTabId(tabId, continuation){
      WALconsole.log("setCurrentTabId", tabId);
      this.tabId = tabId;
      continuation();
      return;
      // we used to try outlier checking.  might be something to consider in future, but didn't seem all the helpful so far
      /*
      this.currentTabIdPageStatsRetrieved = false;
      that.nonOutlierProcessing(data, continuation);
      if (tabId !== undefined){
        utilities.listenForMessageOnce("content", "mainpanel", "pageStats", function(data){
          that.currentTabIdPageStatsRetrieved = true;
          if (that.pageOutlier(data)){
            WALconsole.log("This was an outlier page!");
            var dialogText = "Woah, this page looks very different from what we expected.  We thought we'd get a page that looked like this:";
            if (ReplayScript.prog.mostRecentRow){
              dialogText += "<br>If it's helpful, the last row we scraped looked like this:<br>";
              dialogText += DOMCreationUtilities.arrayOfArraysToTable([ReplayScript.prog.mostRecentRow]).html(); // todo: is this really the best way to acess the most recent row?
            }
            UIObject.addDialog("Weird Page", dialogText, 
              {"I've fixed it": function _fixedHandler(){WALconsole.log("I've fixed it."); that.setCurrentTabId(tabId, continuation);}, 
              "That's the right page": function _rightPageHandler(){WALconsole.log("That's the right page."); that.nonOutlierProcessing(data, continuation);}});
          }
          else{
            that.nonOutlierProcessing(data, continuation);
          }
        });
        MiscUtilities.repeatUntil(
          function(){utilities.sendMessage("mainpanel", "content", "pageStats", {}, null, null, [tabId], null);}, 
          function(){return that.currentTabIdPageStatsRetrieved;},
    function(){},
          1000, true);
      }
      else{
        continuation();
      }
      */
    };

    this.clearCurrentTabId = function _clearCurrentTabId(){
      this.tabId = undefined;
    };

    this.nonOutlierProcessing = function _nonOutlierProcessing(pageData, continuation){
      // wasn't an outlier, so let's actually update the pageStats
      this.updatePageStats(pageData);
      continuation();
    }

    this.pageOutlier = function _pageOutlier(pageData){
      return outlier(this.pageStats.numNodes, pageData.numNodes); // in future, maybe just iterate through whatever attributes we have, but not sure yet
    }

    this.updatePageStats = function _updatePageStats(pageData){
      this.pageStats.numNodes.insert(pageData.numNodes); // it's sorted
    }
    
    this.clearRelationData = function _clearRelationData(){
      this.pageRelations = {};
      WALconsole.namedLog("prinfo", "clear relation data");
    }

    this.originalTabId = function _originalTabId(){
      WALconsole.log(this.recordTimeFrameData);
      if (this.recordTimeFrameData){
        return this.recordTimeFrameData.tab;
      }
      return null;
    }

    this.currentTabId = function _currentTabId(){
      return this.tabId;
    }

    this.toString = function _toString(){
      return this.name;
    }

    this.clearRunningState = function _clearRunningState(){
      this.tabId = undefined;
      this.pageStats = freshPageStats();
      this.clearRelationData();
    };

    this.pageStats = freshPageStats();

  };

  pub.Concatenate = function _Concatenate(left, right){
    Revival.addRevivalLabel(this);
    setBlocklyLabel(this, "concatenate");

    this.left = left;
    this.right = right;

    this.remove = function _remove(){
      this.parent.removeChild(this);
    }

    this.prepareToRun = function _prepareToRun(){
      return;
    };
    this.clearRunningState = function _clearRunningState(){
      return;
    }

    this.toStringLines = function _toStringLines(){
      return ["concatenate"];
    };

    this.hasText = function _hasText(){
      return true; // if we're messing around with a concat, seems like we must have text planned
    }

    this.updateBlocklyBlock = function _updateBlocklyBlock(program, pageVars, relations){
      addToolboxLabel(this.blocklyLabel, "text");
      Blockly.Blocks[this.blocklyLabel] = {
        init: function() {
          this.appendValueInput("left");
          this.appendDummyInput().appendField("+");
          this.appendValueInput("right");
          this.setInputsInline(true);
          this.setOutput(true, 'Bool');
          this.setColour(25);

          var wal = getWAL(this);
          if (!wal){
            setWAL(this, new pub.Concatenate());
          }
        }
      };
    };

    this.genBlocklyNode = function _genBlocklyNode(prevBlock, workspace){
      this.block = workspace.newBlock(this.blocklyLabel);
      setWAL(this.block, this);
      if (this.left){
        attachToInput(this.block, this.left.genBlocklyNode(this.block, workspace), "left");
      }
      if (this.right){
        attachToInput(this.block, this.right.genBlocklyNode(this.block, workspace), "right");
      }
      return this.block;
    };

    this.getHelena = function _getHelena(){
      // ok, but we also want to update our own condition object
      var leftBlock = this.block.getInput('left').connection.targetBlock();
      var rightBlock = this.block.getInput('right').connection.targetBlock();
      if (leftBlock){
        this.left = getWAL(leftBlock).getHelena();
      }
      else{
        this.left = null;
      }
      if (rightBlock){
        this.right = getWAL(rightBlock).getHelena();
      }
      else{
        this.right = null;
      }
      return this;
    };

    this.traverse = function _traverse(fn, fn2){
      fn(this);
      if (this.left){this.left.traverse(fn, fn2);}
      if (this.right){ this.right.traverse(fn, fn2);}
      fn2(this);
    };

    this.run = function _run(runObject, rbbcontinuation, rbboptions){
      // now run the things on which we depend
      this.left.run(runObject, rbbcontinuation, rbboptions);
      this.right.run(runObject, rbbcontinuation, rbboptions);

      var leftVal = this.left.getCurrentVal(); // todo: make this float not int
      var rightVal = this.right.getCurrentVal();
      this.currentVal = leftVal + rightVal;
    };
    this.getCurrentVal = function _getCurrentVal(){
      return this.currentVal;
    };
    this.parameterizeForRelation = function _parameterizeForRelation(relation){
      return [];
    };
    this.unParameterizeForRelation = function _unParameterizeForRelation(relation){
      return;
    };
  };

  // the whole program

  pub.Program = function _Program(statements, addOutputStatement){
    if (addOutputStatement === undefined){addOutputStatement = true;}
    Revival.addRevivalLabel(this);
    if (statements){ // for revival, statements will be undefined
      this.statements = statements;
      this.relations = [];
      this.pageVars = _.uniq(_.map(_.filter(statements, function(s){return s.pageVar;}), function(statement){return statement.pageVar;}));                                                                                                                                                                                 
      this.loopyStatements = statements;  
      this.name = "";
      this.associatedString = null; // one of the things we're allowed to save to server is an associated string, can be used for different things
    }

    var program = this;

    // add an output statement to the end if there are any scrape statements in the program.  should have a list of all scrape statements, treat them as cells in one row
    var scrapeStatements = _.filter(this.statements, function(statement){return statement instanceof WebAutomationLanguage.ScrapeStatement;});
    if (addOutputStatement && scrapeStatements.length > 0){ this.statements.push(new WebAutomationLanguage.OutputRowStatement(scrapeStatements));}

    this.removeChild = function _removeChild(childStatement){
      this.loopyStatements = _.without(this.loopyStatements, childStatement);
    };
    this.removeChildren = function _removeChild(childStatements){
      this.bodyStatements = _.difference(this.bodyStatements, childStatements);
    };
    this.appendChild = function _appendChild(childStatement){
      var newChildStatements = this.loopyStatements;
      newChildStatements.push(childStatement);
      this.updateChildStatements(newChildStatements);
    };
    this.insertChild = function _appendChild(childStatement, index){
      var newChildStatements = this.loopyStatements;
      newChildStatements.splice(index, 0, childStatement);
      this.updateChildStatements(newChildStatements);
    };

    this.setName = function _setName(str){
      this.name = str;
    }
    this.getName = function _getName(){
      return this.name;
    }
    this.setAssociatedString = function _setAssociatedString(str){
      this.associatedString = str;
    }
    this.getAssociatedString = function _getAssociatedString(){
      return this.associatedString;
    }

    this.setId = function _setId(id){
      this.id = id;
      if (UIObject.programIdUpdated){
        UIObject.programIdUpdated(this);
      }
    }

    this.toString = function _toString(){
      var statementLs = this.loopyStatements;
      if (this.loopyStatements.length === 0){
        statementLs = this.statements;
      }
      var scriptString = "";
      _.each(statementLs, function(statement){
        var strLines = statement.toStringLines();
        if (strLines.length > 0){
          scriptString += strLines.join("<br>") + "<br>";
        }});
      return scriptString;
    };

    this.currentStatementLs = function _currentStatementLs(){
      var statementLs = this.loopyStatements;
      if (this.loopyStatements.length === 0){
        statementLs = this.statements;
      }
      return statementLs;
    }

    this.displayBlockly = function _displayBlockly(workspace){

      var statementLs = this.currentStatementLs();

      // let's start with the real program, go through that

      var coords = null;
      if (statementLs[0].block){
        var coords = statementLs[0].block.getRelativeToSurfaceXY();
        statementLs[0].block.dispose(); // get rid of old version (discarding any unsaved blockly changes!)
      }
      
      // now that we removed the real program, let's take this moment to grab all the alternative roots
      // we'll use these later
      var rootBlocklyBlocks = workspace.getTopBlocks();
      var rt = helenaSeqToBlocklySeq(statementLs, workspace); // add new version
      if (coords){
        rt.moveBy(coords.x, coords.y); // make it show up in same spot as before
      }

      // now let's go through all the other stuff the user might have lying around the workspace

      this.altRootLoopyStatements = []; // clear out the current list of other roots that we associate with the program
      for (var i = 0; i < rootBlocklyBlocks.length; i++){
        var rootWAL = getWAL(rootBlocklyBlocks[i]);
        if (!rootWAL){
          continue; // huh, no helena associated with this one.  guess we'll just throw it out
        }
        var helenaSeq = blocklySeqToHelenaSeq(rootBlocklyBlocks[i]);
        this.altRootLoopyStatements.push(helenaSeq);

        // delete the old version from the workspace
        var coords = rootBlocklyBlocks[i].getRelativeToSurfaceXY();
        rootBlocklyBlocks[i].dispose();
        // now display the new version
        var r = helenaSeqToBlocklySeq(helenaSeq, workspace);
        if (coords){
          r.moveBy(coords.x, coords.y); // make it show up in same spot as before
        }
      }  

      // now go through and actually display all those nodes
      // this will traverse all relevant nodes of this.loopyStatements and this.allRootLoopyStatements
      this.traverse(function(statement){
        if (statement.block){
          statement.block.initSvg();
          statement.block.render();
        }
      });

    };

    // for saving a program to the server
    // progName is the name you want to give the program
    // postIdRetrievalContinuation ... because saving the full program can take a really long time, it's best to
    //    just keep going as soon as you have the necessary program id, let the saving happen in the background
    //    so that's what your postIdRetrievalContinuation should do
    // saveStartedHandler ... if you want to give some UI feedback about having started the save, here's the spot
    // saveCompletedHandler ... if you want to give some UI feedback about having completed the full save (including
    //    the full program, not just having retrieved the correct program id), here's the spot
    this.saveToServer = function _saveToServer(postIdRetrievalContinuation, saveStartedHandler, saveCompletedHandler){
      var prog = this;
      var msg = {id: prog.id, name: prog.name, tool_id: toolId, associated_string: prog.associatedString};
      WALconsole.log("about to post", (new Date().getTime()/1000));
      // this first request is just to get us the right program id to associate any later stuff with.  it won't actually save the program
      // saving the program takes a long time, so we don't want other stuff to wait on it, will do it in background
      MiscUtilities.postAndRePostOnFailure(helenaServerUrl+'/saveprogram', msg, function(response){
        WALconsole.log("server responded to program save");
        var progId = response.program.id;
        prog.setId(progId);
        // ok, now that we know the right program id (in cases where there wasn't one to begin with) we can save the actual program
        // but it can take a long time for programs to arrive at server, so don't make other stuff wait on it.  just send it in the background
        setTimeout(function(){
          var relationObjsSerialized = _.map(
            _.filter(prog.relations, function(rel){return rel instanceof WebAutomationLanguage.Relation;}), // todo: in future, don't filter.  actually save textrelations too
            ServerTranslationUtilities.JSONifyRelation);
          var serializedProg = ServerTranslationUtilities.JSONifyProgram(prog);
          // sometimes serializedProg becomes null because of errors.  in those cases, we don't want to overwrite the old, good program with the bad one
          // so let's prevent us from saving null in place of existing thing so that user can shut it off, load the saved program, start over
          if (serializedProg){
            var msg = {id: progId, serialized_program: serializedProg, relation_objects: relationObjsSerialized, name: prog.name, associated_string: prog.associatedString};
            MiscUtilities.postAndRePostOnFailure(helenaServerUrl+'/saveprogram', msg, function(){
              // we've finished the save thing, so tell the user
              saveCompletedHandler();
            },true," to save the program");
          }
        }, 0);

        // ok, we've set it up to do the actual program saving, but we already have the id, so do the postIdRetrievalContinuation
        if (postIdRetrievalContinuation && _.isFunction(postIdRetrievalContinuation)){
          postIdRetrievalContinuation(progId);
        }
      });
      // we've sent the save thing, so tell the user
      saveStartedHandler();
    };

    // a convenient way to traverse the statements of a program
    // todo: currently no way to halt traversal, may ultimately want fn arg to return boolean to do that
    this.traverse = function _traverse(fn, fn2){
      if (fn2 === undefined){
        fn2 = function(){return;};
      }
      if (this.loopyStatements.length < 1){
        WALconsole.warn("Calling traverse on a program even though loopyStatements is empty.");
      }

      // go through our actual programs
      for (var i = 0; i < this.loopyStatements.length; i++){
        this.loopyStatements[i].traverse(fn, fn2);
      }

      // go through the other roots that are also available to us (usually because of blockly)
      if (this.altRootLoopyStatements){
        for (var i = 0; i < this.altRootLoopyStatements.length; i++){
          var statements = this.altRootLoopyStatements[i];
          for (var j = 0; j < statements.length; j++){
            statements[j].traverse(fn, fn2);
          }
        }
      }
    };

    // statement traverse because we're not going through expressions, not going through all nodes, just hitting things in the bodyStatements lists
    function firstTrueStatementTraverse(statementLs, fn){
      for (var i = 0; i < statementLs.length; i++){
        if (fn(statementLs[i])){
          return statementLs[i];
        }
        else{
          // ok, this statement didn't do the trick, but maybe the children?
          if (statementLs[i].bodyStatements){
            var ans = firstTrueStatementTraverse(statementLs[i].bodyStatements, fn);
            if (ans){
              return ans;
            }
          }
        }
      }
      return null;
    }

    this.containsStatement = function(statement){
      return firstTrueStatementTraverse(this.loopyStatements, function(s){return s === statement;});
    }

    this.loadsUrl = function(statement){
      return firstTrueStatementTraverse(this.loopyStatements, function(s){return s instanceof WebAutomationLanguage.LoadStatement;});
    }

    function insertAfterHelper(listOfStatements, statementToInsert, statementAfterWhichToInsert){
      for (var i = 0; i < listOfStatements.length; i++){
        if (listOfStatements[i] === statementAfterWhichToInsert){
          listOfStatements.splice(i + 1, 0, statementToInsert); // remember, overwrites the original array bc splice
          return listOfStatements;
        }
        else{
          // ok, haven't found it yet.  mayhaps it belongs in the body statements of this very statement?
          if (listOfStatements[i].bodyStatements){
            // ok, this one has bodyStatements to check
            var possibleNewLs = insertAfterHelper(listOfStatements[i].bodyStatements, statementToInsert, statementAfterWhichToInsert);
            if (possibleNewLs){
              // awesome, we're done
              listOfStatements[i].bodyStatements = possibleNewLs;
              return listOfStatements;
            }
          }
        }
      }
      return null;
    }

    this.insertAfter = function(statementToInsert, statementAfterWhichToInsert){
      var possibleNewLoopyStatements = insertAfterHelper(this.loopyStatements, statementToInsert, statementAfterWhichToInsert);
      if (!possibleNewLoopyStatements){
        WALconsole.warn("Woah, tried to insert after a particular WALStatement, but that statement wasn't in our prog.");
      }
      else{
        this.loopyStatements = possibleNewLoopyStatements;
      }
    };

    function removeStatementAndFollowing(listOfStatements, statement){
      for (var i = 0; i < listOfStatements.length; i++){
        if (listOfStatements[i] === statement){
          var removedSeq = listOfStatements.splice(i); // remember, overwrites the original array bc splice
          return removedSeq;
        }
        else{
          // ok, haven't found it yet.  mayhaps it belongs in the body statements of this very statement?
          if (listOfStatements[i].bodyStatements){
            // ok, this one has bodyStatements to check
            var removedSeq = removeStatementAndFollowing(listOfStatements[i].bodyStatements, statement);
            if (removedSeq){
              // awesome, we're done
              return removedSeq;
            }
          }
        }
      }
      return null;
    }

    // go through the program, look for the movedStatement and any statements/blocks that the Blockly UI would attach to it
    // then remove those from the program
    this.statementRemovedByUI = function(movedStatement, oldPriorStatement){
      //console.log("statementRemovedByUI", movedStatement, oldPriorStatement);
      var seq = removeStatementAndFollowing(this.loopyStatements, movedStatement);
      //console.log("removed the seq:". removedSeq);
      if (!seq){
        WALconsole.warn("Woah, tried to remove a particular WALStatement, but that statement wasn't in our prog.");
      }

      // now, if we end up pulling this same seq back in...better know about the seq
      movedStatement.associatedStatementSequence = seq;
      return seq;
    };

    function insertArrayAt(array, index, arrayToInsert) {
      Array.prototype.splice.apply(array, [index, 0].concat(arrayToInsert));
    }

    function addSeq(listOfStatements, statementSeq, blocklyParentStatement, inputName){
      for (var i = 0; i < listOfStatements.length; i++){
        if (listOfStatements[i] === blocklyParentStatement){
          // awesome, found the new parent.  now the questions is: is this the parent because the new statementSeq
          // comes immediately after it in the listOfStatements?  or because it's the new first
          // seq in the body statements?  blockly does it both ways
          // we'll use inputName to find out
          var s = listOfStatements[i];
          if (inputName === "statements"){
            // ok.  the new seq is going in the body statements, right at the head
            insertArrayAt(s.bodyStatements, 0, statementSeq); // in place, so overwriting the original
          }
          else{
            // ok, not going in the body statements
            // going after this statement in the current listOfStatements
            insertArrayAt(listOfStatements, i + 1, statementSeq); // in place, again, so overwriting the original
          }
          return true;
        }
        else{
          // ok, haven't found it yet.  mayhaps it belongs in the body statements of this very statement?
          if (listOfStatements[i].bodyStatements){
            // ok, this one has bodyStatements to check
            var res = addSeq(listOfStatements[i].bodyStatements, statementSeq, blocklyParentStatement, inputName);
            if (res){
              // awesome, we're done
              return res;
            }
          }
        }
      }
      return false;
    }

    this.statementAddedByUI = function(movedStatement, precedingStatement, inputName){
      // a quick precaution.  it's not ok for statements to appear in the same program twice.  so make sure it's not already in there...
      // (this comes up when we're programmatically producing the blockly rep for an existing program)
      if (this.containsStatement(movedStatement)){
        return;
      }

      // ok, we know which block is coming in, but don't necessarily know whether there's a sequence of blocks that should come with it
      // if there's one associated with the block, we'll use that.  otherwise we'll assume it's just the block itself
      // (as when the user has dragged in a brand new block, or even when we're programmatically buidling up the displayed program)
      var addedSeq = movedStatement.seq;
      if (!addedSeq){
        addedSeq = [movedStatement];
      }

      var added = addSeq(this.loopyStatements, addedSeq, precedingStatement, inputName);
      if (!added){
        WALconsole.warn("Woah, tried to insert after a particular WALStatement, but that statement wasn't in our prog.");
      }
      return added;
    }

    this.inputRemovedByUI = function(){

    }
    this.inputAddedByUI = function(){

    }

    this.getDuplicateDetectionData = function _getDuplicateDetectionData(){
      var loopData = [];
      this.traverse(function(statement){
        if (statement instanceof WebAutomationLanguage.LoopStatement){
          var newLoopItem = {}; // the data we're building up
          newLoopItem.loopStatement = statement;
          var nodeVars = statement.relationNodeVariables();
          var childStatements = statement.getChildren();
          var scrapeChildren = [];
          for (var i = 0; i < childStatements.length; i++){
            var s = childStatements[i];
            if (s instanceof WebAutomationLanguage.ScrapeStatement && !s.scrapingRelationItem()){
              scrapeChildren.push(s);
            }
            else if (s instanceof WebAutomationLanguage.LoopStatement){
              // convention right now, since duplicate detection is for avoiding repeat
              // of unnecessary work, is that we make the judgment based on variables available
              // before any nested loops
              break;
            }
          }
          var scrapeChildrenNodeVars = _.map(scrapeChildren, function(scrapeS){return scrapeS.currentNode;});
          nodeVars = nodeVars.concat(scrapeChildrenNodeVars); // ok, nodeVars now has all our nodes
          newLoopItem.nodeVariables = nodeVars;
          // in addition to just sending along the nodeVar objects, we also want to make the table of values
          var displayData = [[], []];
          for (var i = 0; i < nodeVars.length; i++){
            var nv = nodeVars[i];
            displayData[0].push(nv.getName() + " text");
            displayData[1].push(nv.recordTimeText());
            displayData[0].push(nv.getName() + " link");
            displayData[1].push(nv.recordTimeLink());
          }
          newLoopItem.displayData = displayData;
          loopData.push(newLoopItem);
        }
      });
      return loopData;
    };

    this.getNodesFoundWithSimilarity = function _getNodesFoundWithSimilarity(){
      var nodeData = [];
      this.traverse(function(statement){
        if (statement.currentNode && statement.currentNode instanceof WebAutomationLanguage.NodeVariable && statement.currentNode.getSource() === NodeSources.RINGER){
          //var statementData = {name: statement.currentNode}
          nodeData.push(statement.currentNode);
        }
      });
      return nodeData;
    };

    this.updateChildStatements = function _updateChildStatements(newChildStatements){
      this.loopyStatements = newChildStatements;
      for (var i = 0; i < this.loopyStatements.length; i++){
        this.loopyStatements[i].parent = this;
      }
    }

    // just for replaying the straight-line recording, primarily for debugging
    this.replayOriginal = function _replayOriginal(){
      var trace = [];
      _.each(this.statements, function(statement){trace = trace.concat(statement.cleanTrace);});
      _.each(trace, function(ev){EventM.clearDisplayInfo(ev);}); // strip the display info back out from the event objects

      SimpleRecord.replay(trace, null, function(){WALconsole.log("Done replaying.");});
    };

    function alignRecordTimeAndReplayTimeCompletedEvents(recordTimeTrace, replayTimeTrace){
      // we should see corresponding 'completed' events in the traces
      var recCompleted = _.filter(recordTimeTrace, function(ev){return TraceManipulationUtilities.completedEventType(ev) && ev.data.url.indexOf(helenaServerUrl) < 0;}); // todo: should we remove http? // now only doing this for top-level completed events.  will see if this is sufficient
      // have to check for kaofang presence, because otherwise user can screw it up by downloading data in the middle or something like that
      var repCompleted = _.filter(replayTimeTrace, function(ev){return TraceManipulationUtilities.completedEventType(ev) && ev.data.url.indexOf(helenaServerUrl) < 0;});
      WALconsole.log(recCompleted, repCompleted);
      // should have same number of top-level load events.  if not, might be trouble
      if (recCompleted.length !== repCompleted.length){
        WALconsole.log("Different numbers of completed events in record and replay: ", recCompleted, repCompleted);
      }
      // todo: for now aligning solely based on point at which the events appear in the trace.  if we get traces with many events, may need to do something more intelligent
      var smallerLength = recCompleted.length;
      if (repCompleted.length < smallerLength) { smallerLength = repCompleted.length;}
      return [recCompleted.slice(0, smallerLength), repCompleted.slice(0, smallerLength)];
    }

    function updatePageVars(recordTimeTrace, replayTimeTrace, continuation){
      // WALconsole.log("updatePageVars", recordTimeTrace, replayTimeTrace);
      var recordTimeCompletedToReplayTimeCompleted = alignRecordTimeAndReplayTimeCompletedEvents(recordTimeTrace, replayTimeTrace);
      var recEvents = recordTimeCompletedToReplayTimeCompleted[0];
      var repEvents = recordTimeCompletedToReplayTimeCompleted[1];
      // WALconsole.log("recEvents:", recEvents, "repEvents", repEvents);
      updatePageVarsHelper(recEvents, repEvents, 0, continuation);
    }

    function updatePageVarsHelper(recEvents, repEvents, i, continuation){
      if (i >= recEvents.length){
        continuation();
      }
      else{
        var pageVar = EventM.getLoadOutputPageVar(recEvents[i]);
        if (pageVar === undefined){
          updatePageVarsHelper(recEvents, repEvents, i + 1, continuation);
          return;
        }
        // WALconsole.log("Setting pagevar current tab id to:", repEvents[i].data.tabId);
        pageVar.setCurrentTabId(repEvents[i].data.tabId, function(){updatePageVarsHelper(recEvents, repEvents, i + 1, continuation);});
      }
    }

    function tabMappingFromTraces(recordTimeTrace, replayTimeTrace){
      var recordTimeCompletedToReplayTimeCompleted = alignRecordTimeAndReplayTimeCompletedEvents(recordTimeTrace, replayTimeTrace);
      var recEvents = recordTimeCompletedToReplayTimeCompleted[0];
      var repEvents = recordTimeCompletedToReplayTimeCompleted[1];
      var tabIdMapping = {};
      for (var i = 0; i < recEvents.length; i++){
        var recTabId = recEvents[i].data.tabId;
        var repTabId = repEvents[i].data.tabId;
        tabIdMapping[recTabId] = repTabId;
      }
      return tabIdMapping;
    }

/*
    function updatePageVars(recordTimeTrace, replayTimeTrace){
      // we should see corresponding 'completed' events in the traces
      var recCompleted = _.filter(recordTimeTrace, function(ev){return ev.type === "completed" && ev.data.type === "main_frame";}); // now only doing this for top-level completed events.  will see if this is sufficient
      var repCompleted = _.filter(replayTimeTrace, function(ev){return ev.type === "completed" && ev.data.type === "main_frame";});
      WALconsole.log(recCompleted, repCompleted);
      // should have same number of top-level load events.  if not, might be trouble
      if (recCompleted.length !== repCompleted.length){
        WALconsole.log("Different numbers of completed events in record and replay: ", recCompleted, repCompleted);
      }
      // todo: for now aligning solely based on point at which the events appear in the trace.  if we get traces with many events, may need to do something more intelligent
      var smallerLength = recCompleted.length;
      if (repCompleted.length < smallerLength) { smallerLength = repCompleted.length;}
      for (var i = 0; i < smallerLength; i++){
        var pageVar = EventM.getLoadOutputPageVar(recCompleted[i]);
        if (pageVar === undefined){
          continue;
        }
        pageVar.setCurrentTabId(repCompleted[i].data.tabId);
      }
    }
    */

    function ringerBased(statement){
      return (statement instanceof WebAutomationLanguage.LoadStatement
                || statement instanceof WebAutomationLanguage.ClickStatement
                || statement instanceof WebAutomationLanguage.ScrapeStatement
                || statement instanceof WebAutomationLanguage.TypeStatement
                || statement instanceof WebAutomationLanguage.PulldownInteractionStatement
                );
    }
    function ringerBasedAndNotIgnorable(statement){
      return (
        // ringer based and not a scrape statement, so we have to replay for sure
        (ringerBased(statement) && !(statement instanceof WebAutomationLanguage.ScrapeStatement))
         ||
         // a scrape statement and it's not scraping a relation, so we have to run it to find the node
        (statement instanceof WebAutomationLanguage.ScrapeStatement && !statement.scrapingRelationItem()));
    }

    function determineNextBlockStartIndex(loopyStatements){
      var nextBlockStartIndex = loopyStatements.length;
      for (var i = 0; i < loopyStatements.length; i++){
        if (!ringerBased(loopyStatements[i])){ // todo: is this the right condition?
          nextBlockStartIndex = i;
          break;
        }
      }

      if (nextBlockStartIndex === 0){
        WALconsole.namedLog("rbb", "nextBlockStartIndex was 0!  this shouldn't happen!", loopyStatements);
        throw("nextBlockStartIndex 0");
      }
      return nextBlockStartIndex;
    }

    function selectBasicBlockStatements(loopyStatements, nextBlockStartIndex){
      var basicBlockStatements = [];
      for (var i = 0; i < nextBlockStartIndex; i++){
        basicBlockStatements.push(loopyStatements[i]);
      }

      return basicBlockStatements;
    }

    function makeTraceFromStatements(basicBlockStatements){
      var trace = [];
      // label each trace item with the basicBlock statement being used
      var withinScrapeSection = false;
      for (var i = 0; i < basicBlockStatements.length; i++){

        var cleanTrace = basicBlockStatements[i].cleanTrace;

        // first let's figure out whether we're even doing anything with this statement
        if (basicBlockStatements[i].contributesTrace === TraceContributions.NONE){
          continue; // don't need this one.  just skip
        }
        else if (basicBlockStatements[i].contributesTrace === TraceContributions.FOCUS){
          // let's just change the cleanTrace so that it only grabs the focus events
          console.log("Warning: we're including a focus event, which might cause problems.  If you see weird behavior, check this first.");
          cleanTrace = _.filter(cleanTrace, function(ev){return ev.data.type === "focus";});
        }
        else if (basicBlockStatements[i] instanceof pub.ScrapeStatement){
          // remember, scrape statements shouldn't change stuff!  so it should be safe to throw away events
          // we just need to be sure to have one event that actually finds the node and grabs its contets
          var nodeUsingEvent = firstScrapedContentEventInTrace(cleanTrace);
          cleanTrace = [nodeUsingEvent];
        }

        _.each(cleanTrace, function(ev){EventM.setTemporaryStatementIdentifier(ev, i);});

        // ok, now let's deal with speeding up the trace based on knowing that scraping shouldn't change stuff, so we don't need to wait after it
        if (withinScrapeSection){
          // don't need to wait after scraping.  scraping doesn't change stuff.
          if (cleanTrace.length > 0){
            cleanTrace[0].timing.ignoreWait = true;
          }
        }
        if (basicBlockStatements[i] instanceof WebAutomationLanguage.ScrapeStatement){
          withinScrapeSection = true;
          for (var j = 1; j < cleanTrace.length; j++){cleanTrace[j].timing.ignoreWait = true;} // the first event may need to wait after whatever came before
        }
        else{
          withinScrapeSection = false;
        }

        // let's see if we can adapt mac-recorded traces to linux if necessary...
        // todo: clean this up, make it work for different transitions...
        var osString = window.navigator.platform;
        if (osString.indexOf("Linux") > -1){
          //console.log(basicBlockStatements[i].outputPageVars && basicBlockStatements[i].outputPageVars.length > 0);
          if (basicBlockStatements[i].outputPageVars && basicBlockStatements[i].outputPageVars.length > 0){
            _.each(cleanTrace, function(ev){
              if (ev.data.metaKey){ // hey, digging into the ev data here is gross.  todo: fix that
                ev.data.ctrlKeyOnLinux = true;
              }
              EventM.setTemporaryStatementIdentifier(ev, i);});
          }
        }
        // and same deal with mac -> linux?  not sure this is safe in general.  but it is convenient for the moment...
        else if (osString.indexOf("Mac") > -1){
          if (basicBlockStatements[i].outputPageVars && basicBlockStatements[i].outputPageVars.length > 0){
            _.each(cleanTrace, function(ev){
              if (ev.data.ctrlKey){ // hey, digging into the ev data here is gross.  todo: fix that
                ev.data.metaKeyOnMac = true;
              }
              EventM.setTemporaryStatementIdentifier(ev, i);});
          }
        }

        trace = trace.concat(cleanTrace);
      }
      return trace;
    }

    function doTheReplay(runnableTrace, config, basicBlockStatements, runObject, loopyStatements, nextBlockStartIndex, callback, options){

      // first let's throw out any wait time on the first event, since no need to wait for that
      if (runnableTrace.length > 0){
        runnableTrace[0].timing.waitTime = 0;
      }
      SimpleRecord.replay(runnableTrace, config, function(replayObject){
        // use what we've observed in the replay to update page variables
        WALconsole.namedLog("rbb", "replayObject", replayObject);

        // based on the replay object, we need to update any pagevars involved in the trace;
        var trace = [];
        _.each(basicBlockStatements, function(statement){trace = trace.concat(statement.trace);}); // want the trace with display data, not the clean trace
        
        //updatePageVars(trace, replayObject.record.events);
        // ok, it's time to update the pageVars, but remember that's going to involve checking whether we got a reasonable page
        var allPageVarsOk = function(){
          // statements may need to do something based on this trace, so go ahead and do any extra processing
          for (var i = 0; i < basicBlockStatements.length; i++){
            WALconsole.namedLog("rbb", "calling postReplayProcessing on", basicBlockStatements[i]);
            basicBlockStatements[i].postReplayProcessing(runObject, replayObject.record.events, i);
          }

          // once we're done replaying, have to replay the remainder of the script
          program.runBasicBlock(runObject, loopyStatements.slice(nextBlockStartIndex, loopyStatements.length), callback, options);
        };
        updatePageVars(trace, replayObject.record.events, allPageVarsOk);

      },
      // ok, we also want some error handling functions
      {
        nodeFindingWithUserRequiredFeaturesFailure: function(replayObject, ringerContinuation){
          // todo: note that continuation doesn't actually have a continuation yet because of Ringer-level implementation
          // if you decide to start using it, you'll have to go back and fix that.  see record-replay/mainpanel_main.js

          // for now, if we fail to find a node where the user has insisted it has a certain set of features, we want to just skip the row
          // essentially want the continue action, so we want the callback that's supposed to happen at the end of running the rest of the script for this iteration
          // so we'll skip doing  program.runBasicBlock(loopyStatements.slice(nextBlockStartIndex, loopyStatements.length), callback) (as above)
          // instead we'll just do the callback
          WALconsole.warn("rbb: couldn't find a node based on user-required features.  skipping the rest of this row.");

          // even though couldn't complete the whole trace, still need to do updatePageVars because that's how we figure out which
          // tab is associated with which pagevar, so that we can go ahead and do tab closing and back button pressing at the end
          
          var allPageVarsOk = function(){ // this is partly the same as the other allPageVarsOk
            // in the continuation, we'll do the actual move onto the next statement
            options.skipMode = true;
            //options.skipCommitInThisIteration = true; // for now we'll assume that this means we'd want to try again in future in case something new is added

            // once we're done replaying, have to replay the remainder of the script
            // want to skip the rest of the loop body, so go straight to callback
            callback();
          };

          var trace = [];
          _.each(basicBlockStatements, function(statement){trace = trace.concat(statement.trace);}); // want the trace with display data, not the clean trace
          updatePageVars(trace, replayObject.record.events, allPageVarsOk);
        },
        portFailure: function(replayObject, ringerContinuation){
          // for now I haven't seen enough of these failures in person to know a good way to fix them
          // for now just treat them like a node finding failure and continue

          WALconsole.warn("rbb: port failure.  ugh.");

          // even though couldn't complete the whole trace, still need to do updatePageVars because that's how we figure out which
          // tab is associated with which pagevar, so that we can go ahead and do tab closing and back button pressing at the end
          
          var allPageVarsOk = function(){ // this is partly the same as the other allPageVarsOk
            // in the continuation, we'll do the actual move onto the next statement
            options.skipMode = true;
            //options.skipCommitInThisIteration = true; // for now we'll assume that this means we'd want to try again in future in case something new is added

            // once we're done replaying, have to replay the remainder of the script
            // want to skip the rest of the loop body, so go straight to callback
            callback();
          };

          var trace = [];
          _.each(basicBlockStatements, function(statement){trace = trace.concat(statement.trace);}); // want the trace with display data, not the clean trace
          updatePageVars(trace, replayObject.record.events, allPageVarsOk);
        }
      }
      );
    };

    function checkEnoughMemoryToCloneTrace(memoryData, trace){
      var approximateMemoryPerEvent = 133333; // bytes
      //if (data.availableCapacity/data.capacity < 0.1){ // this is for testing
      return (memoryData.availableCapacity) > approximateMemoryPerEvent * trace.length * 2.5;
    }

    function splitOnEnoughMemoryToCloneTrace(trace, ifEnoughMemory, ifNotEnoughMemory){
   var check = function(){
      chrome.system.memory.getInfo(function(data){
        if (checkEnoughMemoryToCloneTrace(data, trace)){
          ifEnoughMemory();
        }
        else{
          ifNotEnoughMemory();
        }
      });
};
  try {
      check();
  }
  catch(err){
      // just try again until it works
      setTimeout(function(){splitOnEnoughMemoryToCloneTrace(trace, ifEnoughMemory, ifNotEnoughMemory);}, 1000);
  }
    }

    function runBasicBlockWithRinger(loopyStatements, options, runObject, callback){
      var nextBlockStartIndex = determineNextBlockStartIndex(loopyStatements); 
      var basicBlockStatements = selectBasicBlockStatements(loopyStatements, nextBlockStartIndex);
      basicBlockStatements = markNonTraceContributingStatements(basicBlockStatements);

      var haveAllNecessaryRelationNodes = doWeHaveRealRelationNodesWhereNecessary(basicBlockStatements, runObject.environment);
      if (!haveAllNecessaryRelationNodes){
        // ok, we're going to have to skip this iteration, because we're supposed to open a page and we just won't know how to
        WALconsole.warn("Had to skip an iteration because of lacking the node we'd need to open a new page");
        // todo: should probably also warn the contents of the various relation variables at this iteration that we're skipping

        // we're essentially done 'replaying', have to replay the remainder of the script
        // and we're doing continue, so set the continue flag to true
        options.skipMode = true;
        program.runBasicBlock(runObject, loopyStatements.slice(nextBlockStartIndex, loopyStatements.length), callback, options);
        return;
      }

      // make the trace we'll replay
      var trace = makeTraceFromStatements(basicBlockStatements);
      if (trace.length < 1){
        // ok, no point actually running Ringer here...  let's skip straight to the 'callback!'
        // statements may need to do something as post-processing, even without a replay so go ahead and do any extra processing
        for (var i = 0; i < basicBlockStatements.length; i++){
          WALconsole.namedLog("rbb", "calling postReplayProcessing on", basicBlockStatements[i]);
          basicBlockStatements[i].postReplayProcessing(runObject, [], i);
        }
        // once we're done replaying, have to replay the remainder of the script
        program.runBasicBlock(runObject, loopyStatements.slice(nextBlockStartIndex, loopyStatements.length), callback, options);
        return;
      }

      // ok, passArguments below is going to clone the trace, and the trace is huge
      // so currently thinking this may often be the place where we get close to running out of memory
      // so let's check and make sure we have enough memory
      // and if we don't, let's make sure the user really wants to continue

      var continueWithScriptExecuted = false;

      function continueWithScript(){
        continueWithScriptExecuted = true;


        // first call the run methods for any statements that have run methods in case it's needed for making the arguments
        // todo: note that this should actually happen interspersed with the ringer replay.  do that evenutally
        for (var i = 0; i < basicBlockStatements.length; i++){
          if (basicBlockStatements[i].run){
            basicBlockStatements[i].run(runObject, function(){}, options);
          }
        }


        // now that we have the trace, let's figure out how to parameterize it
        // note that this should only be run once the current___ variables in the statements have been updated!  otherwise won't know what needs to be parameterized, will assume nothing
        // should see in future whether this is a reasonable way to do it
        WALconsole.namedLog("rbb", "trace", trace);
        var parameterizedTrace = pbv(trace, basicBlockStatements);
        
        // now that we've run parameterization-by-value, have a function, let's put in the arguments we need for the current run
        WALconsole.namedLog("rbb", "parameterizedTrace", parameterizedTrace);
        var runnableTrace = passArguments(parameterizedTrace, basicBlockStatements, runObject.environment);
        var config = parameterizedTrace.getConfig();
        config.targetWindowId = runObject.window;
        WALconsole.namedLog("rbb", "runnableTrace", runnableTrace, config);

        // the above works because we've already put in VariableUses for statement arguments that use relation items, for all statements within a loop, so currNode for those statements will be a variableuse that uses the relation
        // however, because we're only running these basic blocks, any uses of relation items (in invisible events) that happen before the for loop will not get parameterized, 
        // since their statement arguments won't be changed, and they won't be part of the trace that does have statement arguments changed (and thus get the whole trace parameterized for that)
        // I don't see right now how this could cause issues, but it's worth thinking about
        
        doTheReplay(runnableTrace, config, basicBlockStatements, runObject, loopyStatements, nextBlockStartIndex, callback, options);
      }

      /*
      splitOnEnoughMemoryToCloneTrace(trace,
        function(){ // if enough memory
          // plenty of memory.  carry on.
          continueWithScript();
        },
        function(){ // if not enough memory
          // yikes, there's a pretty small amount of memory available at this point.  are you sure you want to go on?
      console.log("decided we don't have enough memory.  pause.");
          var text = "Looks like we're pretty close to running out of memory.  If we keep going, the extension might crash.  Continue anyway?";
          var buttonText = "Continue";
          var dialogDiv = UIObject.continueAfterDialogue(text, buttonText, continueWithScript);

          // we might like to check now and then to see if more memory has been freed up, so that we could start again
          MiscUtilities.repeatUntil(
            function(){
        console.log("do we have enough memory?");
              splitOnEnoughMemoryToCloneTrace(trace,
                function(){ // enough memory now, so we actually want to continue
      console.log("changed our minds.  decided we do have enough memory.");
                  dialogDiv.remove(); // get rid of that dialog, so user doesn't see it
                  continueWithScript();
                },
                function(){}); // if there's not enough memory, just don't do anything, keep waiting for user
            }, // repeat this
            function(){return continueWithScriptExecuted;}, // until this
            function(){}, // don't have any functions to run after the condition is reached
            60000, false); // just check every minute
        });
        */
        continueWithScript();
    }

    this.runBasicBlock = function _runBasicBlock(runObject, loopyStatements, callback, options){
      if (options === undefined){options = {};}
      var skipMode = options.skipMode;
      if (skipMode === undefined){ skipMode = false; }
      var ignoreEntityScope = options.ignoreEntityScope;
      var breakMode = options.breakMode;
      if (breakMode === undefined){ breakMode = false; }
      if (ignoreEntityScope === undefined){ ignoreEntityScope = false; }
      WALconsole.namedLog("rbb", loopyStatements.length, loopyStatements);
      // first check if we're supposed to pause, stop execution if yes
      WALconsole.namedLog("rbb", "runObject.userPaused", runObject.userPaused);
      if (runObject.userPaused){
        var repWindowId = currentReplayWindowId;
        currentReplayWindowId = null;
        runObject.resumeContinuation = function(){
          currentReplayWindowId = repWindowId;
          program.runBasicBlock(runObject, loopyStatements, callback, options);};
        WALconsole.log("paused");
        return;
      }
      WALconsole.log("runObject.userStopped", runObject.userStopped);
      if (runObject.userStopped){
        WALconsole.log("run stopped");
        runObject.userStopped = false; // set it back so that if the user goes to run again, everything will work
        return;
      }

      if (loopyStatements.length < 1){
        WALconsole.namedLog("rbb", "rbb: empty loopystatments.");
        callback(options);
        return;
      }
      // for now LoopStatement gets special processing
      else if (loopyStatements[0] instanceof WebAutomationLanguage.LoopStatement){
        if (skipMode){
          // in this case, when we're basically 'continue'ing, it's as if this loop is empty, so skip straight to that
          program.runBasicBlock(runObject, loopyStatements.slice(1, loopyStatements.length), callback, options);
          return;
        }
        WALconsole.namedLog("rbb", "rbb: loop.");

        var loopStatement = loopyStatements[0];
        var relation = loopStatement.relation;

        function cleanupAfterLoopEnd(continuation){
          loopStatement.rowsSoFar = 0;

          if (loopStatement.pageVar){
            var prinfo = relation.getPrinfo(loopStatement.pageVar);
            WALconsole.namedLog("prinfo", "change prinfo, finding it for cleanup");
            WALconsole.namedLog("prinfo", shortPrintString(prinfo));
            WALconsole.log("prinfo in cleanup", prinfo);
            // have to get rid of this prinfo in case (as when a pulldown menu is dynamically adjusted
            // by another, and so we want to come back and get it again later) we'll want to scrape
            // the same relation fresh from the same page later
            loopStatement.pageVar.pageRelations[loopStatement.relation.name+"_"+loopStatement.relation.id] = undefined; 
            WALconsole.namedLog("prinfo", "cleared a page relation entry"); 
          }
          
          // time to run end-of-loop-cleanup on the various bodyStatements
          loopStatement.traverse(function(statement){
            if (statement.endOfLoopCleanup){
              statement.endOfLoopCleanup(continuation);
            }
          }, function(){});
        }

        // are we actually breaking out of the loop?
        if (breakMode){
          WALconsole.warn("breaking out of the loop");
          options.breakMode = false; // if we were in break mode, we're done w loop, so turn off break mode
          var continuation = function(){
            // once we're done with the loop, have to replay the remainder of the script
            program.runBasicBlock(runObject, loopyStatements.slice(1, loopyStatements.length), callback, options);   
          }
          cleanupAfterLoopEnd(continuation);
          return;
        }

        // have we hit the maximum number of iterations we want to do?
        if (loopStatement.maxRows !== null && loopStatement.rowsSoFar >= loopStatement.maxRows){
          // hey, we're done!
          WALconsole.namedLog("rbb", "hit the row limit");
          var continuation = function(){
            // once we're done with the loop, have to replay the remainder of the script
            program.runBasicBlock(runObject, loopyStatements.slice(1, loopyStatements.length), callback, options);
          }
          cleanupAfterLoopEnd(continuation);
          return;
        }

        // if we're going to simulate an error at any point, is this the point?
        if (options.simulateError){
          var targetIterations = options.simulateError;
          var currentIterations = getLoopIterationCounters(loopStatement); // gets the iterations of this loop and any ancestor loops
          // first make sure we're actually on the right loop.  no need to check if we're still on the outermost loop but breaking in the innermost
          if (currentIterations.length >= targetIterations.length){
            // ok, that last loop is the one we're about to run, including upping the rowsSoFar counter, so up that now.  no need to fetch row if we're supposed to error now
            currentIterations[currentIterations.length - 1] = currentIterations[currentIterations.length - 1] + 1;
            // now that we know we're at the right loop or deeper, let's check...
            var timeToError = true;
            for (var i = 0; i < targetIterations.length; i++){
              if (currentIterations[i] > targetIterations[i]){
                timeToError = true; // ok, it's time.  need this case if we never hit the iteration on an inner loop, so we do the error at the start of the next loop
                break;
              }
              if (currentIterations[i] < targetIterations[i]){
                timeToError = false; // ok, we're not there yet
                break;
              }
              // if it's equal, check the next nested loop
            }
            // at this point, only if all loops were greater than or equal to the target number of iterations will timeToError be true
            if (timeToError){
              // remember, when we rerun, don't error anymore!  don't want an infinite loop.
              options.simulateError = false;
              // first close the old dataset object in order to flush all its data to the server
              runObject.dataset.closeDataset();
              // now restart
              // all other options should be the same, except that we shouldn't simulate the error anymore and must make sure to use the same dataset
              options.dataset_id = runObject.dataset.id;
              runObject.program.run(options); 
              return; // don't run any of the callbacks for this old run!  we're done with it!
            }
          }
        }

        loopStatement.relation.getNextRow(runObject, loopStatement.pageVar, function(moreRows){
          if (!moreRows){
            // hey, we're done!
            WALconsole.namedLog("rbb", "no more rows");
            var continuation = function(){
              // once we're done with the loop, have to replay the remainder of the script
              program.runBasicBlock(runObject, loopyStatements.slice(1, loopyStatements.length), callback, options);
            }
            cleanupAfterLoopEnd(continuation);
            return;
          }
          WALconsole.namedLog("rbb", "we have a row!  let's run");
          // otherwise, should actually run the body
          loopStatement.rowsSoFar += 1;
          // block scope.  let's add a new frame
          runObject.environment = runObject.environment.envExtend(); // add a new frame on there
          WALconsole.namedLog("rbb", "envExtend done");
          // and let's give us access to all the loop variables
          // note that for now loopVarsMap includes all columns of the relation.  may some day want to limit it to only the ones used...
          loopStatement.updateRelationNodeVariables(runObject.environment);
          WALconsole.namedLog("rbb", "loopyStatements", loopyStatements);
          program.runBasicBlock(runObject, loopStatement.bodyStatements, function(){ // running extra iterations of the for loop is the only time we change the callback
            // and once we've run the body, we should do the next iteration of the loop
            // but first let's get rid of that last environment frame
            WALconsole.namedLog("rbb", "rbb: preparing for next loop iteration, popping frame off environment.");
            runObject.environment = runObject.environment.parent;
            // for the next iteration, we'll be back out of skipMode if we were in skipMode
            // and let's run loop cleanup, since we actually ran the body statements
            // we don't skip things in the cleanup, so time to swap those off
            options.skipMode = false;
            options.skipCommitInThisIteration = false;

            // the main way we clean up is by running the cleanupStatements
            program.runBasicBlock(runObject, loopStatement.cleanupStatements, function(){
              // and once we've done that loop body cleanup, then let's finally go ahead and go back to do the loop again!
              WALconsole.namedLog("rbb", "Post-cleanupstatements.")
              program.runBasicBlock(runObject, loopyStatements, callback, options); 
            }, options);
          }, options);
        });
        return;
      }
      // also need special processing for back statements, if statements, continue statements, whatever isn't ringer-based
      else if (!ringerBased(loopyStatements[0])){
        WALconsole.namedLog("rbb", "rbb: non-Ringer-based statement.");

        if (skipMode || breakMode){
          // in this case, when we're basically 'continue'ing, we should do nothing
          program.runBasicBlock(runObject, loopyStatements.slice(1, loopyStatements.length), callback, options);
          return;
        }

        // normal execution, either because we're not in skipMode, or because we are but it's a back or a close
        var continuation = function(rbboptions){ 
        // remember that rbbcontinuations passed to run methods must always handle rbboptions
        // rbboptions includes skipMode to indicate whether we're continuing
          // once we're done with this statement running, have to replay the remainder of the script
          program.runBasicBlock(runObject, loopyStatements.slice(1, loopyStatements.length), callback, rbboptions);
        };
        loopyStatements[0].run(runObject, continuation, options);
        return;
      }
      else {
        WALconsole.namedLog("rbb", "rbb: r+r.");
        // the fun stuff!  we get to run a basic block with the r+r layer

        if (skipMode || breakMode){
          // in this case, when we're basically 'continue'ing, we should do nothing, so just go on to the next statement without doing anything else
          program.runBasicBlock(runObject, loopyStatements.slice(1, loopyStatements.length), callback, options);
          return;
        }

        runBasicBlockWithRinger(loopyStatements, options, runObject, callback);
      }
    }

    function turnOffDescentIntoLockedSkipBlocks(){
      program.traverse(function(statement){
        if (statement instanceof pub.DuplicateAnnotation){
          statement.descendIntoLocks = false;
        }
      });
    }

    function runInternals(program, parameters, dataset, options, continuation){

      // first let's make the runObject that we'll use for all the rest
      // for now the below is commented out to save memory, since only running one per instance
      //var programCopy = Clone.cloneProgram(program); // must clone so that run-specific state can be saved with relations and so on
      var runObject = {program: program, dataset: dataset, environment: Environment.envRoot()};
      currentRunObjects.push(runObject);
      var tab = UIObject.newRunTab(runObject); // the mainpanel tab in which we'll preview stuff
      runObject.tab = tab;

      // let's figure out params first.  parameters may be passed in (e.g., from command line or from tool running on top of Helena language)
      // but we also have some default vals associated with the program object itself
      // we want to start with the default vals associated with the program, but then we're willing to overwrite them with the user-supplied vals
      // so first assign default values, then assign from passed-in parameters arg
      for (var key in program.defaultParamVals){
        if (!(key in parameters)){
          runObject.environment.envBind(key, program.defaultParamVals[key]);
        }
      }

      // let's add the intput parameters to our environment.  todo: in future, should probably make sure we only use params that are associated with prog (store param names with prog...)
      for (var key in parameters){
        runObject.environment.envBind(key, parameters[key]);
      }

      runObject.program.clearRunningState();
      runObject.program.prepareToRun();

      var usesTheWeb = runObject.program.loadsUrl();
      WALconsole.log("usesTheWeb", usesTheWeb);

      var runProgFunc = function(windowId){
        // now let's actually run
        if (usesTheWeb){
          recordingWindowIds.push(windowId);
          runObject.window = windowId;
          currentReplayWindowId = windowId;
        }
        datasetsScraped.push(runObject.dataset.id);
        runObject.program.runBasicBlock(runObject, runObject.program.loopyStatements, function(){

          // ok, we're done.  unless!  are we in parallel mode?  if we're in parallel mode, let's go back
          // and help any workers that are stragglers

          
          // before we start running, let's check if we need to update the continuation in order to make it loop on this script forever
          // (if it's one of those programs where we're supposed to go back and run again as soon as we finish)
          // or if we need to loop again to descend into locked skip blocks
          if (options.parallel){
            // ok, we're ready to do our descent into parallelizing at lower skip blocks
            // todo: this should really grab all the skip blocks at a given level
            // this code will work as long as all skip blocks are nested one inside one, as when our pbd system writes them
            var normalModeSkipBlock = function(statement){
              return (statement instanceof pub.DuplicateAnnotation && statement.descendIntoLocks === false);
            };
            var nextSkipBlockToSwitch = firstTrueStatementTraverse(program.loopyStatements, normalModeSkipBlock);
            if (nextSkipBlockToSwitch){
              nextSkipBlockToSwitch.descendIntoLocks = true;
            }
            var nextSkipBlockToSwitchHasParallelizableSubcomponents = firstTrueStatementTraverse(program.loopyStatements, normalModeSkipBlock);

            if (nextSkipBlockToSwitch && nextSkipBlockToSwitchHasParallelizableSubcomponents){
              // we only want to do another run if there are actually parallelizable subcomponents of the thing we just switched
              // otherwise it's useless to send more workers after the skip blocks that have already been locked by other workers
              // but here we have both, so let's actually run again
              runInternals(program, parameters, dataset, options, continuation); // todo: do we need to do anything to clean up here?  is program state ok?
              // now return so we don't do the normal whatToDoWhenWereDone stuff that we'll do when we've really finished
              return;
            }
            else{
              // ok, we wanted to find a next skip block, but we ran out.  let's set them all back to false
              turnOffDescentIntoLockedSkipBlocks();
              // next we'll fall through out of this if statement and do the normal processing for being done, actually close the dataset and all
            }
          }

          function whatToDoWhenWereDone(){
            scrapingRunsCompleted += 1;
            console.log("scrapingRunsCompleted", scrapingRunsCompleted);
            currentRunObjects = _.without(currentRunObjects, runObject);
            WALconsole.log("Done with script execution.");
            var timeScraped = (new Date()).getTime() - parseInt(dataset.pass_start_time);
            console.log(runObject.dataset.id, timeScraped);

            if (usesTheWeb){ recordingWindowIds = _.without(recordingWindowIds, windowId); } // take that window back out of the allowable recording set
            // go ahead and actually close the window so we don't have chrome memory leaking all over the place.
            // todo: put this back in!
            //chrome.windows.remove(windowId);


            // if there was a continuation provided for when we're done, do it
            if (continuation){
              continuation(runObject.dataset, timeScraped, runObject.tab);
            }
          }

          runObject.dataset.closeDatasetWithCont(whatToDoWhenWereDone);

        }, options);
      };

      // now actually call the function for running the program
      // ok let's do this in a fresh window
      if (usesTheWeb){
        if (runObject.program.windowWidth){
          var width = runObject.program.windowWidth;
          var height = runObject.program.windowHeight;
          MiscUtilities.makeNewRecordReplayWindow(runProgFunc, undefined, width, height);
        }
        else{
          MiscUtilities.makeNewRecordReplayWindow(runProgFunc);
        }
      }
      else{
        // no need to make a new window (there are no load statements in the program), so don't
        runProgFunc(null);
      }
    }

    function adjustDatasetNameForOptions(dataset, options){
      if (options.ignoreEntityScope){
        dataset.appendToName("_ignoreEntityScope");
      }
      if (options.nameAddition){
        dataset.appendToName(options.nameAddition); // just for scripts that want more control of how it's saved
      }
    }

    var internalOptions = ["skipMode", "breakMode", "skipCommitInThisIteration"]; // wonder if these shouldn't be moved to runObject instead of options.  yeah.  should do that.
    var recognizedOptions = ["dataset_id", "ignoreEntityScope", "breakAfterXDuplicatesInARow", "nameAddition", "simulateError", "parallel", "hashBasedParallel", "restartOnFinish"];
    this.run = function _run(options, continuation, parameters, requireDataset){
      console.log("program run");
      console.log("options", options);
      console.log("continuation", continuation);
      console.log("parameters", parameters);
      if (options === undefined){options = {};}
      if (parameters === undefined){parameters = {};}
      if (requireDataset === undefined){requireDataset = true;} // you should only have false requireDataset if you're positive your users shouldn't be putting in output rows...
      WALconsole.log("parameters", parameters);
      for (var prop in options){
        if (recognizedOptions.indexOf(prop) < 0){
          // woah, bad, someone thinks they're providing an option that will affect us, but we don't know what to do with it
          // don't let them think everything's ok, especially since they probably just mispelled
          WALconsole.warn("Woah, woah, woah.  Tried to provide option " + prop + " to program run, but we don't know what to do with it.");
          if (internalOptions.indexOf(prop) > -1){
            // ok, well an internal prop sneaking in is ok, so we'll just provide a warning.  otherwise we're actually going to stop
            WALconsole.warn("Ok, we're allowing it because it's an internal option, but we're not happy about it and we're setting it to false.");
      options[prop] = false;
          }
          else{
            return;
          }
        }
      }

      turnOffDescentIntoLockedSkipBlocks(); // in case we left the last run in a bad state, let's go ahead and make sure we'll parallelize at top level

      // before we start running, let's check if we need to update the continuation in order to make it loop on this script forever
      // (if it's one of those programs where we're supposed to go back and run again as soon as we finish)
      var fullContinuation = continuation;
      if (program.restartOnFinish || options.restartOnFinish === true){
        // yep, we want to repeat.  time to make a new continuation that, once it finishes the original coninutation
        // will make a new dataset and start over.  the loop forever option/start again when done option
        fullContinuation = function(dataset, timeScraped, tabId){
          if (continuation) {continuation(dataset, timeScraped, options);}
          program.run(options, continuation, parameters, tabId);
        }
      }

      if (options.dataset_id){
        // no need to make a new dataset
        var dataset = new OutputHandler.Dataset(program, options.dataset_id);
        runInternals(this, parameters, dataset, options, fullContinuation);
      }
      else{
        // ok, have to make a new dataset
        var dataset = new OutputHandler.Dataset(program);
        // it's really annoying to go on without having an id, so let's wait till we have one
        function continueWork(){
          adjustDatasetNameForOptions(dataset, options);
          runInternals(program, parameters, dataset, options, fullContinuation);       
        }

        if (requireDataset){
          MiscUtilities.repeatUntil(
            function(){}, 
            function(){return dataset.isReady();},
            function(){
              continueWork();
            },
            1000, true
          );
        }
        else{
          continueWork();
        }
      }
    };

    this.restartFromBeginning = function _restartFromBeginning(runObjectOld, continuation){
      // basically same as above, but store to the same dataset (for now, dataset id also controls which saved annotations we're looking at)
      runObjectOld.program.run({dataset_id: runObjectOld.dataset.id}, continuation);
    };

    this.stopRunning = function _stopRunning(runObject){
      if (!runObject.userPaused){
        // don't need to stop continuation chain unless it's currently going; if paused, isn't going, stopping flag won't get turned off and will prevent us from replaying later
        runObject.userStopped = true; // this will stop the continuation chain
      }
      // should we even bother saving the data?
      runObject.dataset.closeDataset();
      this.clearRunningState();
      SimpleRecord.stopReplay(); // todo: is current (new) stopReplay enough to make sure that when we try to run the script again, it will start up correctly?
    };

    this.clearRunningState = function _clearRunningState(){
      _.each(this.relations, function(relation){relation.clearRunningState();});
      _.each(this.pageVars, function(pageVar){pageVar.clearRunningState();});
      this.traverse(function(statement){statement.clearRunningState();});
    };

    this.parameterNames = []; // by default, no parameters
    console.log("parameterNames", this.parameterNames);
    this.setParameterNames = function _setParameterNames(paramNamesLs){
      console.log("setParameterNames", paramNamesLs);
      this.parameterNames = paramNamesLs;
      // when you make parameters, they might be referred to by NodeVariableUse expressions
      // so you need to make node variables for them (even though of course they aren't nodes)
      // todo: do we want to restructure this in some way?
      for (var i = 0; i < paramNamesLs.length; i++){
        var nodeVar = getNodeVariableByName(paramNamesLs[i]);
        if (!nodeVar){
          new pub.NodeVariable(paramNamesLs[i], {}, {}, null, NodeSources.PARAMETER);
        }
      }
    }
    this.getParameterNames = function _getParameterNames(){
      return this.parameterNames;
    }

    this.defaultParamVals = {};
    this.setParameterDefaultValue = function _setParameterDefaultValue(paramName, paramVal){
      this.defaultParamVals[paramName] = paramVal;
    };

    this.getParameterDefaultValues = function _getParameterDefaultValues(){
      return this.defaultParamVals;
    };

    this.getAllVariableNames = function _getAllVariables(){
      var variableNames = this.getParameterNames().slice(); // start with the parameters to the program
      this.traverse(function(statement){
        if (statement instanceof WebAutomationLanguage.LoopStatement){
          variableNames = variableNames.concat(statement.relation.columnNames());
        }
        else if (statement instanceof WebAutomationLanguage.ScrapeStatement && !statement.scrapingRelationItem()){
          variableNames.push(statement.currentNode.getName());
        }
      });
      var uniqueVariableNames = _.uniq(variableNames);
      return uniqueVariableNames;
    };

    this.prepareToRun = function _prepareToRun(){
      this.traverse(function(statement){statement.prepareToRun();});
    };

    function paramName(statementIndex, paramType){ // assumes we can't have more than one of a single paramtype from a single statement.  should be true
      return "s"+statementIndex+"_"+paramType;
    }

    function pbv(trace, statements){
      var pTrace = new ParameterizedTrace(trace);

      for (var i = 0; i < statements.length; i++){
        var statement = statements[i];
        var pbvs = statement.pbvs();
        WALconsole.log("pbvs", pbvs);
        for (var j = 0; j < pbvs.length; j++){
          var currPbv = pbvs[j];
          var pname = paramName(i, currPbv.type);
          if (currPbv.type === "url"){
            pTrace.parameterizeUrl(pname, currPbv.value);
          }
          else if (currPbv.type === "node"){
            pTrace.parameterizeXpath(pname, currPbv.value);
          }
          else if (currPbv.type === "typedString"){
            pTrace.parameterizeTypedString(pname, currPbv.value);
          }
          else if (currPbv.type === "tab"){
            pTrace.parameterizeTab(pname, currPbv.value);
          }
          else if (currPbv.type === "frame"){
            pTrace.parameterizeFrame(pname, currPbv.value);
          }
          else if (currPbv.type === "property"){
            pTrace.parameterizeProperty(pname, currPbv.value);
          }
          else{
            WALconsole.log("Tried to do pbv on a type we don't know.");
          }
        }
      }
      return pTrace;
    }

    var wrapperNodeCounter = 0;
    function parameterizeWrapperNodes(pTrace, origXpath, newXpath){
      // todo: should we do something to exempt xpaths that are already being parameterized based on other relation elements?
      // for now this is irrelevant because we'll come to the same conclusion  because of using fixed suffixes, but could imagine different approach later
      var origSegs = origXpath.split("/");
      var newSegs = newXpath.split("/");
      if (origSegs.length !== newSegs.length){ WALconsole.log("origSegs and newSegs different length!", origXpath, newXpath); }
      for (var i = 0; i < origSegs.length; i++){ // assumption: origSegs and newSegs have same length; we'll see
        if (origSegs[origSegs.length - 1 - i] === newSegs[newSegs.length - 1 - i]){
          // still match
          // we do need the last segment ot match, but the one that goes all the way to the last segment is the one that inspired this
          // so we don't need to param the last one again, but we do need to param the one prior, even if it doesn't match
          // (the first one that doesn't match should still be parameterized)
          // a1/b1/c1/a1/a1/a1 -> d1/e1/f1/a2/a1/a1 original already done;  we should do a1/b1/c1/a1/a1 -> d1/e1/f1/a2/a1, a1/b1/c1/a1 -> d1/e1/f1/a2
          var origXpathPrefix = origSegs.slice(0,origSegs.length - 1 - i).join("/");
          var newXpathPrefix = newSegs.slice(0,newSegs.length - 1 - i).join("/");
          var pname = "wrappernode_"+wrapperNodeCounter;
          wrapperNodeCounter += 1;
          pTrace.parameterizeXpath(pname, origXpathPrefix);
          pTrace.useXpath(pname, newXpathPrefix);
          WALconsole.log("Wrapper node correction:");
          WALconsole.log(origXpathPrefix);
          WALconsole.log(newXpathPrefix);
        }
        else {
          // this one is now diff, so shouldn't do replacement for the one further
          // (shouldn't do a1/b1/c1 -> d1/e1/f1 from example above)
          // I mean, maybe we actually should do this, but not currently a reason to think it will be useful.  worth considering though
          break;
        }
      }
    }

    function passArguments(pTrace, statements, environment){
      for (var i = 0; i < statements.length; i++){
        var statement = statements[i];
        var args = statement.args(environment);
        for (var j = 0; j < args.length; j++){
          var currArg = args[j];
          var pname = paramName(i, currArg.type);
          if (currArg.type === "url"){
            pTrace.useUrl(pname, currArg.value);
          }
          else if (currArg.type === "node"){
            pTrace.useXpath(pname, currArg.value);
            // the below is kind of gross and I don't know if this is really where it should happen, but we definitely want to parameterize wrapper nodes
            // todo: maybe find a cleaner, nice place to put this or write this.  for now this should do the trick
            parameterizeWrapperNodes(pTrace, statement.node, currArg.value);
          }
          else if (currArg.type === "typedString"){
            pTrace.useTypedString(pname, currArg.value);
          }
          else if (currArg.type === "tab"){
            pTrace.useTab(pname, currArg.value);
          }
          else if (currArg.type === "frame"){
            pTrace.useFrame(pname, currArg.value);
          }
          else if (currArg.type === "property"){
            pTrace.useProperty(pname, currArg.value);
          }
          else{
            WALconsole.log("Tried to do pbv on a type we don't know. (Arg provision.)");
          }
        }
      }

      return pTrace.getStandardTrace();
    }

    function longestCommonPrefix(strings) {
      if (strings.length < 1) {
        return "";
      }
      if (strings.length == 1){
        return strings[0];
      }

      var sorted = strings.slice(0).sort(); // copy
      var string1 = sorted[0];
      var string2 = sorted[sorted.length - 1];
      var i = 0;
      var l = Math.min(string1.length, string2.length);

      while (i < l && string1[i] === string2[i]) {
        i++;
      }

      return string1.slice(0, i);
    }

    var pagesToNodes = {};
    var pagesToUrls = {};
    var pagesProcessed = {};
    var pagesToFrameUrls = {};
    var pagesToFrames = {};
    this.relevantRelations = function _relevantRelations(){
      // ok, at this point we know the urls we've used and the xpaths we've used on them
      // we should ask the server for relations that might help us out
      // when the server gets back to us, we should try those relations on the current page
      // we'll compare those against the best we can create on the page right now, pick the winner

      // get the xpaths used on the urls
      // todo: right now we're doing this on a page by page basis, splitting into assuming it's one first row per page (tab)...
      // but it should really probably be per-frame, not per tab
      for (var i = 0; i < this.statements.length; i++){
        var s = this.statements[i];
        if ( (s instanceof WebAutomationLanguage.ScrapeStatement) || (s instanceof WebAutomationLanguage.ClickStatement) || (s instanceof WebAutomationLanguage.PulldownInteractionStatement) ){
          var xpath = s.node; // todo: in future, should get the whole node info, not just the xpath, but this is sufficient for now
          var pageVarName = s.pageVar.name; // pagevar is better than url for helping us figure out what was on a given logical page
          var url = s.pageVar.recordTimeUrl;
          var frameUrl = s.trace[0].frame.URL;
          var frameId = s.trace[0].frame.iframeIndex;

          if (!(pageVarName in pagesToNodes)){ pagesToNodes[pageVarName] = []; }
          if (pagesToNodes[pageVarName].indexOf(xpath) === -1){ pagesToNodes[pageVarName].push(xpath); }

          if (!(pageVarName in pagesToFrameUrls)){ pagesToFrameUrls[pageVarName] = []; }
          pagesToFrameUrls[pageVarName].push(frameUrl);

          if (!(pageVarName in pagesToFrames)){ pagesToFrames[pageVarName] = []; }
          pagesToFrames[pageVarName].push(frameId);

          pagesToUrls[pageVarName] = url;
        }
      }
      // ask the server for relations
      // sample: $($.post('http://localhost:3000/retrieverelations', { pages: [{xpaths: ["a[1]/div[2]"], url: "www.test2.com/test-test"}] }, function(resp){ WALconsole.log(resp);} ));
      var reqList = [];
      for (var pageVarName in pagesToNodes){
        reqList.push({url: pagesToUrls[pageVarName], xpaths: pagesToNodes[pageVarName], page_var_name: pageVarName, frame_ids: pagesToFrames[pageVarName]});

      }
      var that = this;
      MiscUtilities.postAndRePostOnFailure(helenaServerUrl+'/retrieverelations', { pages: reqList }, function(resp){that.processServerRelations(resp);},true," to tell us about any relevant tables");
    }

    function isScrapingSet(keyCodes){
      var charsDict = {SHIFT: 16, CTRL: 17, ALT: 18, CMD: 91};
      keyCodes.sort();
      var acceptableSets = [
        [charsDict.ALT], // mac scraping
        [charsDict.CTRL, charsDict.ALT], // unix scraping
        [charsDict.ALT, charsDict.SHIFT], // mac link scraping
        [charsDict.CTRL, charsDict.ALT, charsDict.SHIFT] // unix link scraping
      ];
      for (var i = 0; i < acceptableSets.length; i++){
        var acceptableSet = acceptableSets[i];
        acceptableSet.sort();
        if (_.isEqual(keyCodes, acceptableSet)){
          return true;
        }
      }
      // nope, none of them are the right set
      return false;
    }

    var TraceContributions = {
      NONE: 0,
      FOCUS: 1
    };

    function sameNodeIsNextUsed(statement, statements){
      WALconsole.log("sameNodeIsNextUsed", statement, statements);
      if (!statement.origNode){ // there's no node associated with the first arg
        console.log("Warning!  No node associated with the statement, which may mean there was an earlier statement that we should have called on.");
        return false;
      }
      for (var i = 0; i < statements.length; i++){
        if (statements[i].origNode === statement.origNode) {
          return true;
        }
        if (statements[i] instanceof WebAutomationLanguage.ClickStatement){ // || statements[i] instanceof WebAutomationLanguage.ScrapeStatement){
          // ok, we found another statement that focuses a node, but it's a different node
          // todo: is this the right condition?  certainly TypeStatements don't always have the same origNode as the focus event that came immediately before
          return false;
        }
      }
      // we've run out
      return false;
    }

    function doWeHaveRealRelationNodesWhereNecessary(statements, environment){
      for (var i = 0; i < statements.length; i++){
        var s = statements[i];
        if (s.outputPageVars && s.outputPageVars.length > 0){
          // ok, this is an interaction where we should be opening a new page based on the statement
          if (s.columnObj){
            // if the statement is parameterized with the column object of a given relation, this will be non-null
            // also, it means the statement's currentNode will be a NodeVariable, so we can call currentXPath
            // also it means we'll already have assigned to the node variable, so currentXPath should actually have a value
            var currentXpath = s.currentNode.currentXPath(environment);
            if (currentXpath){
              continue;
            }
            return false; // we've found a statement for which we'll want to use a node to produce a new page, but we won't have one
          }
        }
      }
      return true;
    }

    function markNonTraceContributingStatements(statements){
      // if we ever get a sequence within the statements that's a keydown statement, then only scraping statements, then a keyup, assume we can toss the keyup and keydown ones

      WALconsole.log("markNonTraceContributingStatements", statements);

      // ok first some special handling for cases where the only statements in the block aren't ringer-y at all
      // it's possible that this will sometimes screw things up.  if you ever get annoying weird behavior, 
      // where the page stops reacting correctly, this might be a place to look
      // but it's just so annoying when the scripts are slow on things that don't need to be slow.  so we're
      // gonna do it anyway

      var allNonRinger = true;
      for (var i = 0; i < statements.length; i++){
        //console.log("ringerBasedButNotScraping", ringerBasedButNotScraping(statements[i]), statements[i]);
        if (ringerBasedAndNotIgnorable(statements[i]) && !statements[i].nullBlockly){
          allNonRinger = false;
          break;
        }
      }
      if (allNonRinger){
        //console.log("Cool, found a situation where we can ignore all statements", statements);
        for (var i = 0; i < statements.length; i++){
          statements[i].contributesTrace = TraceContributions.NONE;
        }
        return statements;
      }

      var keyIndexes = [];
      var keysdown = [];
      var keysup = [];
      var sets = [];
      for (var i = 0; i < statements.length; i++){
        if (statements[i] instanceof WebAutomationLanguage.TypeStatement && statements[i].onlyKeydowns){
          // we're seeing typing, but only keydowns, so it might be the start of entering scraping mode
          keyIndexes.push(i);
          keysdown = keysdown.concat(statements[i].keyCodes);
        }
        else if (keyIndexes.length > 0 && statements[i] instanceof WebAutomationLanguage.ScrapeStatement 
                    && statements[i].scrapingRelationItem()){
          // cool, we think we're in scraping mode, and we're scraping a relation-scraped thing, so no need to
          // actually execute these events with Ringer
          statements[i].contributesTrace = TraceContributions.FOCUS;
          continue;
        }
        else if (keyIndexes.length > 0 && statements[i] instanceof WebAutomationLanguage.TypeStatement && statements[i].onlyKeyups){
          // ok, looks like we might be about to pop out of scraping mode

          keyIndexes.push(i);
          keysup = keysup.concat(statements[i].keyCodes);

          // ok, do the keysdown and keysup arrays have the same elements (possibly including repeats), just reordered?
          // todo: is this a strong enough condition?
          keysdown.sort();
          keysup.sort();
          // below: are we letting up all the same keys we put down before?  and are the keys from a set we might use for
          // entering scraping mode?
          if (_.isEqual(keysdown, keysup) && isScrapingSet(keysdown)) {
            WALconsole.log("decided to remove set", keyIndexes, keysdown);
            sets.push(keyIndexes);
            keyIndexes = [];
            keysdown = [];
            keysup = [];
          }
        }
        else if (keyIndexes.length > 0 && !(statements[i] instanceof WebAutomationLanguage.ScrapeStatement && statements[i].scrapingRelationItem())){
          // well drat.  we started doing something that's not scraping a relation item
          // maybe clicked, or did another interaction, maybe just scraping something where we'll rely on ringer's node finding abilities
          // but in either case, we need to actually run Ringer
          keyIndexes = [];
          keysdown = [];
          keysup = [];
        }
      }
      // ok, for now we're only going to get rid of the keydown and keyup statements
      // they're in sets because may ultimately want to try manipulating scraping statements in the middle if they don't have dom events (as when relation parameterized)
      // but for now we'll stick with this

      // todo: I'd like to get rid of the above and switch to just checking for a given event whether all contained events had additional.scrape set
      // the only complication is the focus thing mentioned below

      for (var i = 0; i < sets.length; i++){
        var set = sets[i];

        // let's ignore the events associated with all of these statements!
        for (var j = set[0]; j < set[set.length -1] + 1; j++){
          var statement = statements[j];
          statement.contributesTrace = TraceContributions.NONE;
        }
        // ok, one exception.  sometimes the last relation scraping statement interacts with the same node that we'll use immediately after scraping stops
        // in these cases, during record, the focus was shifted to the correct node during scraping, but the replay won't shift focus unless we replay that focus event
        // so we'd better replay that focus event
        var keyupIndex = set[set.length - 1];
        if (sameNodeIsNextUsed(statements[keyupIndex - 1], statements.slice(keyupIndex + 1, statements.length))){
          // is it ok to restrict it to only statements replayed immediately after?  rather than in a for loop that's coming up or whatever?
          // it's definitely ok while we're only using our own inserted for loops, since those get inserted where we start using a new node
          var lastStatementBeforeKeyup = statements[keyupIndex - 1];
          WALconsole.log("lastStatementBeforeKeyup", lastStatementBeforeKeyup);
          lastStatementBeforeKeyup.contributesTrace = TraceContributions.FOCUS;
          // let's make sure to make the state match the state it should have, based on no longer having these keypresses around
          var cleanTrace = lastStatementBeforeKeyup.cleanTrace;
          _.each(cleanTrace, function(ev){if (ev.data.ctrlKey){ev.data.ctrlKey = false;}}); // right now hard coded to get rid of ctrl alt every time.  todo: fix
          _.each(cleanTrace, function(ev){if (ev.data.altKey){ev.data.altKey = false;}});
        }

        /* an alternative that removes keyup, keydown events instead of the whole statements
        for (var j = set.length - 1; j >= 0; j--){
          //statements.splice(set[j], 1);
          var statement = statements[set[j]];
          console.log("statement", statement);
          var cleanTrace = statement.cleanTrace;
          for (var l =  cleanTrace.length - 1; l >= 0; l--){
            if (cleanTrace[l].data.type === "keyup" || cleanTrace[l].data.type === "keydown"){
              cleanTrace.splice(l, 1);
            }
          }
        }
        */
        
      }
      
      WALconsole.log("markNonTraceContributingStatements", statements);
      return statements;
    }

    this.processServerRelations = function _processServerRelations(resp, currentStartIndex, tabsToCloseAfter, tabMapping, windowId, pageCount=0){
      if (currentStartIndex === undefined){currentStartIndex = 0;}
      if (tabsToCloseAfter === undefined){tabsToCloseAfter = [];}
      if (tabMapping === undefined){tabMapping = {};}
      // we're ready to try these relations on the current pages
      // to do this, we'll have to actually replay the script

      var startIndex = currentStartIndex;

      var runRelationFindingInNewWindow = function(windowId){
        // let's find all the statements that should open new pages (where we'll need to try relations)
        for (var i = currentStartIndex; i < program.statements.length; i++){
          if (program.statements[i].outputPageVars && program.statements[i].outputPageVars.length > 0){
            pageCount += 1;
            if (UIObject.handleRelationFindingPageUpdate){
              UIObject.handleRelationFindingPageUpdate(pageCount);
            }

            // todo: for now this code assumes there's exactly one outputPageVar.  this may not always be true!  but dealing with it now is a bad use of time
            var targetPageVar = program.statements[i].outputPageVars[0];
            WALconsole.log("processServerrelations going for index:", i, targetPageVar);

            // this is one of the points to which we'll have to replay
            var statementSlice = program.statements.slice(startIndex, i + 1);
            var trace = [];
            _.each(statementSlice, function(statement){trace = trace.concat(statement.cleanTrace);});
            //_.each(trace, function(ev){EventM.clearDisplayInfo(ev);}); // strip the display info back out from the event objects

            WALconsole.log("processServerrelations program: ", program);
            WALconsole.log("processServerrelations trace indexes: ", startIndex, i);
            WALconsole.log("processServerrelations trace:", trace.length);

            var nextIndex = i + 1;

            // ok, we have a slice of the statements that should produce one of our pages. let's replay
            // todo, if we fail to find it with this approach, start running additional statements
            // (seomtimes the relation is only displayed after user clicks on an element, that kind of thing)
            SimpleRecord.replay(trace, {tabMapping: tabMapping, targetWindowId: windowId}, function(replayObj){
              // continuation
              WALconsole.log("replayobj", replayObj);

              // what's the tab that now has the target page?
              var replayTrace = replayObj.record.events;
              var lastCompletedEvent = TraceManipulationUtilities.lastTopLevelCompletedEvent(replayTrace);
              var lastCompletedEventTabId = TraceManipulationUtilities.tabId(lastCompletedEvent);
              // what tabs did we make in the interaction in general?
              tabsToCloseAfter = tabsToCloseAfter.concat(TraceManipulationUtilities.tabsInTrace(replayTrace));
              // also sometimes it's important that we bring this tab (on which we're about to do relation finding)
              // to be focused, so that it will get loaded and we'll be able to find the relation
              chrome.tabs.update(lastCompletedEventTabId, {"active": true}, function(tab){ });
              // I know I know, I should really have all the rest of this inside the callback for the tab update
              // but we didn't even do this in the past and it's pretty fast...

              // let's do some trace alignment to figure out a tab mapping
              var newMapping = tabMappingFromTraces(trace, replayTrace);
              tabMapping = _.extend(tabMapping, newMapping);
              WALconsole.log(newMapping, tabMapping);

              // and what are the server-suggested relations we want to send?
              var resps = resp.pages;
              var suggestedRelations = null;
              for (var i = 0; i < resps.length; i++){
                var pageVarName = resps[i].page_var_name;
                if (pageVarName === targetPageVar.name){
                  suggestedRelations = [resps[i].relations.same_domain_best_relation, resps[i].relations.same_url_best_relation];
                  for (var j = 0; j < suggestedRelations.length; j++){
                    if (suggestedRelations[j] === null){ continue; }
                      suggestedRelations[j] = ServerTranslationUtilities.unJSONifyRelation(suggestedRelations[j]); // is this the best place to deal with going between our object attributes and the server strings?
                  }
                }
              }
              if (suggestedRelations === null){
                WALconsole.log("Panic!  We found a page in our outputPageVars that wasn't in our request to the server for relations that might be relevant on that page.");
              }

              var framesHandled = {};

              // we'll do a bunch of stuff to pick a relation, then we'll call this function
              var handleSelectedRelation = function(data){
                // handle the actual data the page sent us, if we're still interested in adding loops

                // if we're in this but the user has told us to stop trying to automatically add relations, let's stop
                if (program.automaticLoopInsertionForbidden){
                  return; // don't even go running more ringer stuff if we're not interested in seeing more loops inserted
                }

                // ok, normal processing.  we want to add a loop for this relation
                if (data){
                  program.processLikelyRelation(data);
                }
                // update the control panel display
                UIObject.updateDisplayedRelations(true); // true because we're still unearthing interesting relations, so should indicate we're in progress
                // now let's go through this process all over again for the next page, if there is one
                WALconsole.log("going to processServerRelations with nextIndex: ", nextIndex);
                program.processServerRelations(resp, nextIndex, tabsToCloseAfter, tabMapping, windowId, pageCount);
              };

              if (UIObject.handleFunctionForSkippingToNextPageOfRelationFinding){
                UIObject.handleFunctionForSkippingToNextPageOfRelationFinding(handleSelectedRelation);
              }

              // this function will select the correct relation from amongst a bunch of frames' suggested relatoins
              var processedTheLikeliestRelation = false;
              var pickLikelyRelation = function(){
                if (processedTheLikeliestRelation){
                  return; // already did this.  don't repeat
                }
                for (var key in framesHandled){
                  if (framesHandled[key] === false){
                    return; // nope, not ready yet.  wait till all the frames have given answers
                  }
                }
                WALconsole.log("framesHandled", framesHandled); // todo: this is just debugging

                var dataObjs = _.map(Object.keys(framesHandled), function(key){ return framesHandled[key]; });
                WALconsole.log("dataObjs", dataObjs);
                // todo: should probably do a fancy similarity thing here, but for now we'll be casual
                // we'll sort by number of cells, then return the first one that shares a url with our spec nodes, or the first one if none share that url
                dataObjs = _.filter(dataObjs, function(obj){return obj !== null && obj !== undefined;});
                var sortedDataObjs = _.sortBy(dataObjs, function(data){ if (!data || !data.first_page_relation || !data.first_page_relation[0]){return -1;} else {return data.first_page_relation.length * data.first_page_relation[0].length; }}); // ascending
          sortedDataObjs = sortedDataObjs.reverse();
                WALconsole.log("sortedDataObjs", sortedDataObjs);
                var frameUrls = pagesToFrameUrls[targetPageVar.name];
                WALconsole.log("frameUrls", frameUrls, pagesToFrameUrls, targetPageVar.name);
                var mostFrequentFrameUrl = _.chain(frameUrls).countBy().pairs().max(_.last).head().value(); // a silly one-liner for getting the most freq
                _.each(sortedDataObjs, function(data){
                  if (data.url === mostFrequentFrameUrl){
                    // ok, this is the one
                    // now that we've picked a particular relation, from a particular frame, actually process it
                    processedTheLikeliestRelation = true;
                    handleSelectedRelation(data);
                    return;
                  }
                });
                // drat, none of them had the exact same url.  ok, let's just pick the first
                if (sortedDataObjs.length < 1){
                  WALconsole.log("Aaaaaaaaaaah there aren't any frames that offer good relations!  Why???");
                  return;
                }
                processedTheLikeliestRelation = true;
                handleSelectedRelation(sortedDataObjs[0]);
              };

              function sendMessageForFrames(frames){
                framesHandled = {};
                  frames.forEach(function(frame){
                    // keep track of which frames need to respond before we'll be read to advance
                    WALconsole.log("frameId", frame);
                    framesHandled[frame] = false;
                  });
                  frames.forEach(function(frame) {
                      // for each frame in the target tab, we want to see if the frame suggests a good relation.  once they've all made their suggestions
                      // we'll pick the one we like best
                      // todo: is there a better way?  after all, we do know the frame in which the user interacted with the first page at original record-time
                      
                      // here's the function for sending the message once
                      var getLikelyRelationFunc = function(){
                        utilities.sendFrameSpecificMessage("mainpanel", "content", "likelyRelation", 
                                                            {xpaths: pagesToNodes[targetPageVar.name], pageVarName: targetPageVar.name, serverSuggestedRelations: suggestedRelations}, 
                                                            lastCompletedEventTabId, frame, 
                                                            // question: is it ok to insist that every single frame returns a non-null one?  maybe have a timeout?  maybe accept once we have at least one good response from one of the frames?
                                                            function(response) { if (response) {response.frame = frame; framesHandled[frame] = response; pickLikelyRelation();}}); // when get response, call pickLikelyRelation (defined above) to pick from the frames' answers
                      };

                      // here's the function for sending the message until we get the answer
                      var getLikelyRelationFuncUntilAnswer = function(){
                        if (framesHandled[frame]){ return; } // cool, already got the answer, stop asking
                        getLikelyRelationFunc(); // send that message
                        setTimeout(getLikelyRelationFuncUntilAnswer, 5000); // come back and send again if necessary
                      };

                      // actually call it
                      getLikelyRelationFuncUntilAnswer();

                  });
              }

              var allFrames = pagesToFrames[targetPageVar.name];
              allFrames = _.uniq(allFrames);
              if (allFrames.length === 1 && allFrames[0] === -1){
                // cool, it's just the top-level frame
                // just do the top-level iframe, and that will be faster
                sendMessageForFrames([0]); // assumption: 0 is the id for the top-level frame
              }
              else{
                // ok, we'll have to ask the tab what frames are in it
                // let's get some info from the pages, and when we get that info back we can come back and deal with more script segments
                var checkFramesFunc = function(){
                  chrome.webNavigation.getAllFrames({tabId: lastCompletedEventTabId}, function(details) {
                                  console.log("about to send to frames, tabId", lastCompletedEventTabId);
                                  var frames = _.map(details, function(d){return d.frameId;});
                                  sendMessageForFrames(frames);
                                });
                };
                setTimeout(checkFramesFunc, 0); // for pages that take a long time to actually load the right page (redirects), can increase this; todo: fix it a real way by trying over and over until we get a reasonable answer
              }

            });
            return; // all later indexes will be handled by the recursion instead of the rest of the loop
          }
        }
        // ok we hit the end of the loop without returning after finding a new page to work on.  time to close tabs
        tabsToCloseAfter = _.uniq(tabsToCloseAfter); 
        console.log("tabsToCloseAfter", tabsToCloseAfter);     
        // commenting out the actual tab closing for debugging purposes
        /*
        for (var i = 0; i < tabsToCloseAfter.length; i++){
          console.log("processServerRelations removing tab", tabsToCloseAfter[i]);
          chrome.tabs.remove(tabsToCloseAfter[i], function(){
            // do we need to do anything?
          }); 
        }
        */
        /*
        chrome.windows.remove(windowId);
        */
        // let's also update the ui to indicate that we're no longer looking
        UIObject.updateDisplayedRelations(false);

      };

      // if this is our first time calling this function, we'll need to make a new window for our exploration of pages
      // so we don't just choose a random one
      // but if we've already started, no need, can juse use the windowId we already know
      if (!windowId){
        if (program.windowWidth){
          var width = program.windowWidth;
          var height = program.windowHeight;
          MiscUtilities.makeNewRecordReplayWindow(runRelationFindingInNewWindow, undefined, width, height);
        }
        else{
          MiscUtilities.makeNewRecordReplayWindow(runRelationFindingInNewWindow);
        }
      }
      else{
        runRelationFindingInNewWindow(windowId);
      }

    };

    this.forbidAutomaticLoopInsertion = function(){
      this.automaticLoopInsertionForbidden = true;
    }

    this.processLikelyRelation = function _processLikelyRelation(data){
      WALconsole.log(data);
      if (pagesProcessed[data.page_var_name]){
        // we already have an answer for this page.  must have gotten sent multiple times even though that shouldn't happen
        WALconsole.log("Alarming.  We received another likely relation for a given pageVar, even though content script should prevent this.");
        return this.relations;
      }
      pagesProcessed[data.page_var_name] = true;

      if (data.num_rows_in_demonstration < 2 && data.next_type === NextTypes.NONE){
        // what's the point of showing a relation with only one row?
      }
      else{
        // if we have a normal selector, let's add that to our set of relations
        if (data.selector){
          var rel = new WebAutomationLanguage.Relation(data.relation_id, data.name, data.selector, data.selector_version, data.exclude_first, data.columns, data.first_page_relation, data.num_rows_in_demonstration, data.page_var_name, data.url, data.next_type, data.next_button_selector, data.frame);
          this.relations.push(rel);
          this.relations = _.uniq(this.relations);
        }
        // if we also have pulldown menu selectors, let's add those too
        if (data.pulldown_relations){
          for (var i = 0; i < data.pulldown_relations.length; i++){
            var relMsg = data.pulldown_relations[i];
            var rel = new WebAutomationLanguage.Relation(relMsg.relation_id, relMsg.name, relMsg.selector, relMsg.selector_version, relMsg.exclude_first, relMsg.columns, relMsg.first_page_relation, relMsg.num_rows_in_demonstration, relMsg.page_var_name, relMsg.url, relMsg.next_type, relMsg.next_button_selector, relMsg.frame);
            this.relations.push(rel);
            this.relations = _.uniq(this.relations);
          }
        }
      }

      WALconsole.log(pagesToNodes);

      if (!this.automaticLoopInsertionForbidden){
        this.insertLoops(true);
      }

      // give the text relations back to the UI-handling component so we can display to user
      return this.relations;
    };

    function parameterizeBodyStatementsForRelation(bodyStatementLs, relation){
      var relationColumnsUsed = [];
      for (var j = 0; j < bodyStatementLs.length; j++){
        relationColumnsUsed = relationColumnsUsed.concat(bodyStatementLs[j].parameterizeForRelation(relation));
      }
      relationColumnsUsed = _.uniq(relationColumnsUsed);
      relationColumnsUsed = _.without(relationColumnsUsed, null);
      return relationColumnsUsed;
    }

    function loopStatementFromBodyAndRelation(bodyStatementLs, relation, pageVar){
      // we want to parameterize the body for the relation
      var relationColumnsUsed = parameterizeBodyStatementsForRelation(bodyStatementLs, relation); 

      // ok, and any pages to which we travel within a loop's non-loop body nodes must be counteracted with back buttons at the end
      // todo: come back and make sure we only do this for pages that aren't being opened in new tabs already, and maybe ultimately for pages that we can't convert to open in new tabs
      var backStatements = [];
      for (var j = 0; j < bodyStatementLs.length; j++){
        var statement = bodyStatementLs[j];
        if (statement.outputPageVars && statement.outputPageVars.length > 0){
          // we're making that assumption again about just one outputpagevar.  also that everything is happening in one tab.  must come back and revisit this
          var currPage = statement.outputPageVars[0];
          var backPage = statement.pageVar;
          if (backPage && currPage.originalTabId() === backPage.originalTabId()){
            // only need to add back button if they're actually in the same tab (may be in diff tabs if CTRL+click, or popup, whatever)
            backStatements.push(new WebAutomationLanguage.BackStatement(currPage, backPage));
          }
          else{
            // we're going back to messing with an earlier page, so should close the current page
            // insert a statement that will do that
            backStatements.push(new WebAutomationLanguage.ClosePageStatement(currPage));
          }
        }
      }
      backStatements.reverse(); // must do the back button in reverse order

      var cleanupStatementLs = backStatements;
      // todo: also, this is only one of the places we introduce loops.  should do this everywhere we introduce or adjust loops.  really need to deal with the fact those aren't aligned right now

      var loopStatement = new WebAutomationLanguage.LoopStatement(relation, relationColumnsUsed, bodyStatementLs, cleanupStatementLs, pageVar); 
      return loopStatement;
    }

    this.insertLoops = function _insertLoops(updateProgPreview){
      var indexesToRelations = {}; // indexes into the statements mapped to the relations used by those statements
      for (var i = 0; i < this.relations.length; i++){
        var relation = this.relations[i];
        for (var j = 0; j < this.statements.length; j++){
          var statement = this.statements[j];
          if (relation.usedByStatement(statement)){
            var loopStartIndex = j;
            // let's do something a little  different in cases where there's a keydown right before the loop, since the keyups will definitely happen within
            // todo: may even need to look farther back for keydowns whose keyups happen within the loop body
            if (this.statements[j-1] instanceof WebAutomationLanguage.TypeStatement && this.statements[j-1].onlyKeydowns){
              loopStartIndex = j - 1;
            }
            indexesToRelations[loopStartIndex] = relation;
            break;
          }
        }
      }

      this.updateChildStatements(this.statements);
      var indexes = _.keys(indexesToRelations).sort(function(a, b){return b-a}); // start at end, work towards beginning
      for (var i = 0; i < indexes.length; i++){
        var index = indexes[i];
        // let's grab all the statements from the loop's start index to the end, put those in the loop body
        var bodyStatementLs = this.loopyStatements.slice(index, this.loopyStatements.length);
        var pageVar = bodyStatementLs[0].pageVar; // pageVar comes from first item because that's the one using the relation, since it's the one that made us decide to insert a new loop starting with that 
        var loopStatement = loopStatementFromBodyAndRelation(bodyStatementLs, indexesToRelations[index], pageVar); // let's use bodyStatementLs as our body, indexesToRelations[index] as our relation 
        
        var newChildStatements = this.loopyStatements.slice(0, index);
        newChildStatements.push(loopStatement);
        this.updateChildStatements(newChildStatements);
      }

      if (updateProgPreview){
        UIObject.updateDisplayedScript();
        // now that we know which columns are being scraped, we may also need to update how the relations are displayed
        UIObject.updateDisplayedRelations();
      }
    };

    this.tryAddingRelation = function _tryAddingRelation(relation){
      var relationUsed = tryAddingRelationHelper(relation, this.loopyStatements, this);
      // for now we'll add it whether or not it actually get used, but this may not be the best way...
      this.relations.push(relation);
    }

    function tryAddingRelationHelper(relation, loopyStatements, parent){ // parent will be either the full program or a loop statement
      for (var i = 0; i < loopyStatements.length; i++){
        var statement = loopyStatements[i];
        if (statement instanceof WebAutomationLanguage.LoopStatement){
          var used = tryAddingRelationHelper(relation, statement.bodyStatements, statement);
          if (used) {return used;} // if we've already found a use for it, we won't try to use it twice.  so at least for now, as long as we only want one use, we should stop checking here, not continue
        }
        if (relation.usedByStatement(statement)){
          // ok, let's assume the rest of this loop's body should be nested
          var bodyStatementLs = loopyStatements.slice(i, loopyStatements.length);
          var loopStatement = loopStatementFromBodyAndRelation(bodyStatementLs, relation, statement.pageVar); // statement uses relation, so pick statement's pageVar
          // awesome, we have our new loop statement, which should now be the final statement in the parent
          var newStatements = loopyStatements.slice(0,i);
          newStatements.push(loopStatement);
          parent.updateChildStatements(newStatements);
          return true;
        }
      }
      return false;
    }

    this.removeRelation = function _removeRelation(relationObj){
      this.relations = _.without(this.relations, relationObj);

      // now let's actually remove any loops that were trying to use this relation
      var newChildStatements = removeLoopsForRelation(this.loopyStatements, relationObj);
      this.updateChildStatements(newChildStatements);
      this.insertLoops(); // if the removed relation was using the same cell as another potential relation, that one may now be relevant

      UIObject.updateDisplayedScript();
      UIObject.updateDisplayedRelations();
    };

    function removeLoopsForRelation(loopyStatements, relation){
      var outputStatements = [];
      for (var i = 0; i < loopyStatements.length; i++){
        if (loopyStatements[i] instanceof WebAutomationLanguage.LoopStatement){
          if (loopyStatements[i].relation === relation){
            // ok, we want to remove this loop; let's pop the body statements back out into our outputStatements
            var bodyStatements = removeLoopsForRelation(loopyStatements[i].bodyStatements, relation);
            outputStatements = outputStatements.concat(bodyStatements);
          }
          else{
            // we want to keep this loop, but we'd better descend and check the loop body still
            var newChildStatements = removeLoopsForRelation(loopyStatements[i].bodyStatements, relation);
            loopyStatements[i].updateChildStatements(newChildStatements);
            outputStatements.push(loopyStatements[i]);
          }
        }
        else{
          // not a loop statement
          loopyStatements[i].unParameterizeForRelation(relation);
          outputStatements.push(loopyStatements[i]);
        }
      }
      return outputStatements;
    }

    // by default, we'll wait up to 15 seconds for the target node to appear (see ringer/common/common_params.js)
    // for static pages, this is silly
    // user may want to provide a custom timeout
    // this particular function resets the wait for all events in the program, which is easy but not always a good idea
    this.setCustomTargetTimeout = function _setCustomTargetTimeout(timeoutSeconds){
      this.traverse(function(statement){
        if (statement.cleanTrace){
          for (var i = 0; i < statement.cleanTrace.length; i++){
            statement.cleanTrace[i].targetTimeout = timeoutSeconds;
          }
        }
      });
    };

  }

  // END of Program

  pub.updateBlocklyBlocks = function _updateBlocklyBlocks(program){
    // have to update the current set of blocks based on our pageVars, relations, so on

    // this is silly, but just making a new object for each of our statements is an easy way to get access to
    // the updateBlocklyBlock function and still keep it an instance method/right next to the genBlockly function
    var toolBoxBlocks = ["Number", "NodeVariableUse", "String", "Concatenate", "IfStatement", 
    "WhileStatement", 
    "ContinueStatement", "BinOpString", "BinOpNum", "LengthString",
      "BackStatement", "ClosePageStatement", "WaitStatement", "WaitUntilUserReadyStatement", "SayStatement"];
    // let's also add in other nodes which may not have been used in programs so far, but which we want to include in the toolbox no matter what
    var origBlocks = blocklyNames;
    var allDesiredBlocks = origBlocks.concat(toolBoxBlocks);

    for (var i = 0; i < allDesiredBlocks.length; i++){
      var prop = allDesiredBlocks[i];
      if (typeof pub[prop] === "function"){
          try{
            var obj = new pub[prop]();
          }
          catch(err){
            console.log("Couldn't create new object for prop:", prop, "probably by design.");
            console.log(err);
          }
          if (obj && obj.updateBlocklyBlock){
            if (program){
              obj.updateBlocklyBlock(program, program.pageVars, program.relations)
            }
            else{
              obj.updateBlocklyBlock();
            }
          };
      }
    }

    // let's just warn about what things (potentially blocks!) aren't being included
    for (var prop in pub){
      if (allDesiredBlocks.indexOf(prop) < 0){
        WALconsole.log("NOT INCLUDING PROP:", prop);
      }
    }
    return;
  };

  // time to apply labels for revival purposes
  for (var prop in pub){
    if (typeof pub[prop] === "function"){
      WALconsole.log("making revival label for ", prop);
      Revival.introduceRevivalLabel(prop, pub[prop]);
    }
  }

  new pub.WaitStatement(); // make one so we'll add the blocklylabel
  return pub;
}());
