// @see ../routes for routing

var _ = require('lodash');
var nconf = require('nconf');
var async = require('async');
var algos = require('habitrpg-shared/script/algos');
var helpers = require('habitrpg-shared/script/helpers');
var items = require('habitrpg-shared/script/items');
var User = require('./../models/user').model;
var Group = require('./../models/group').model;
var api = module.exports;

/*
  ------------------------------------------------------------------------
  Groups
  ------------------------------------------------------------------------
*/

var itemFields = 'items.armor items.head items.shield items.weapon items.currentPet';
var partyFields = 'profile preferences stats achievements party backer flags.rest auth.timestamps ' + itemFields;
var nameFields = 'profile.name';

function removeSelf(group, user){
  group.members = _.filter(group.members, function(m){return m._id != user._id});
}

api.getMember = function(req, res) {
  User.findById(req.params.uid).select(partyFields).exec(function(err, user){
    if (err) return res.json(500,{err:err});
    if (!user) return res.json(400,{err:'User not found'});
    res.json(user);
  })
}

/**
 * Fetch groups list. This no longer returns party or tavern, as those can be requested indivdually
 * as /groups/party or /groups/tavern
 */
api.getGroups = function(req, res) {
  var user = res.locals.user;
  var groupFields = 'name description memberCount';
  var sort = '-memberCount';

  async.parallel({

    // unecessary given our ui-router setup
    party: function(cb){
      return cb(null, [{}]);
    },

    guilds: function(cb) {
      Group.find({members: {'$in': [user._id]}, type:'guild'})
        .select(groupFields).sort(sort).exec(cb);
    },

    'public': function(cb) {
      Group.find({privacy: 'public'})
        .select(groupFields + ' members')
        .sort(sort)
        .exec(function(err, groups){
          if (err) return cb(err);
          _.each(groups, function(g){
            // To save some client-side performance, don't send down the full members arr, just send down temp var _isMember
            if (~g.members.indexOf(user._id)) g._isMember = true;
            g.members = undefined;
          });
          cb(null, groups);
        });
    },

    // unecessary given our ui-router setup
    tavern: function(cb) {
      return cb(null, [{}]);
    }

  }, function(err, results){
    if (err) return res.json(500, {err: err});
    res.json(results);
  })
};

/**
 * Get group
 * TODO: implement requesting fields ?fields=chat,members
 */
api.getGroup = function(req, res) {
  var user = res.locals.user;
  var gid = req.params.gid;

  // This will be called for the header, we need extra members' details than usuals
  if (gid == 'party') {
    Group.findOne({type: 'party', members: {'$in': [user._id]}})
      .populate('members', partyFields).exec(function(err, group){
        if (err) return res.json(500,{err:err});
        removeSelf(group, user);
        res.json(group);
      });
  } else {
    Group.findById(gid).populate('members', nameFields).exec(function(err, group){
      if ( (group.type == 'guild' && group.privacy == 'private') || group.type == 'party') {
        if(!_.find(group.members, {_id: user._id}))
          return res.json(401, {err: "You don't have access to this group"});
      }
      // Remove self from party (see above failing `match` directive in `populate`
      if (group.type == 'party') {
        removeSelf(group, user);
      }
      res.json(group);
    })
  }

};


api.createGroup = function(req, res, next) {
  var group = new Group(req.body);
  var user = res.locals.user;

  if(group.type === 'guild'){
    if(user.balance < 1) return res.json(401, {err: 'Not enough gems!'});

    group.balance = 1;
    user.balance--;

    user.save(function(err){
      if(err) return res.json(500,{err:err});
      group.save(function(err, saved){
        if (err) return res.json(500,{err:err});
        return res.json(saved);
      });
    });    
  }else{
    group.save(function(err, saved){
      if (err) return res.json(500,{err:err});
      return res.json(saved);
    });
  }
}

api.updateGroup = function(req, res, next) {
  var group = res.locals.group;
  'name description logo websites logo leaderMessage'.split(' ').forEach(function(attr){
    group[attr] = req.body[attr];
  });
  async.series([
    function(cb){group.save(cb);},
    function(cb){
      var fields = group.type == 'party' ? partyFields : 'profile.name';
      Group.findById(group._id).populate('members', fields).exec(cb);
    }
  ], function(err, results){
    if (err) return res.json(500,{err:err});
    if (group.type === 'party') removeSelf(results[1], res.locals.user);
    res.json(results[1]);
  })
}

api.attachGroup = function(req, res, next) {
  Group.findById(req.params.gid, function(err, group){
    if(err) return res.json(500, {err:err});
    res.locals.group = group;
    next();
  })
}

api.postChat = function(req, res, next) {
  var user = res.locals.user
  var group = res.locals.group;
  var message = {
    id: helpers.uuid(),
    uuid: user._id,
    contributor: user.backer && user.backer.contributor,
    npc: user.backer && user.backer.npc,
    text: req.query.message, // FIXME this should be body, but ngResource is funky
    user: user.profile.name,
    timestamp: +(new Date)
  };

  group.chat.unshift(message);
  group.chat.splice(200);

  if (group.type === 'party') {
    user.party.lastMessageSeen = message.id;
    user.save();
  }

  async.series([
    function(cb){group.save(cb)},
    function(cb){
      Group.findById(group._id).populate('members', partyFields).exec(cb);
    }
  ], function(err, results){
    if (err) return res.json(500, {err:err});

    // TODO This is less efficient, but see https://github.com/lefnire/habitrpg/commit/41255dc#commitcomment-4014583
    var saved = results[1];
    if (group.type === 'party') removeSelf(saved, user);

    res.json(saved);
  })
}

api.deleteChatMessage = function(req, res, next){
  var user = res.locals.user
  var group = res.locals.group;
  var message = _.find(group.chat, {id: req.params.messageId});

  if(message === undefined) return res.json(404, {err: "Message not found!"});

  if(user.id !== message.uuid && !(user.backer && user.backer.admin)){
    return res.json(401, {err: "Not authorized to delete this message!"})
  }

  group.chat = _.without(group.chat, message);
  
  group.save(function(err, data){
    if(err) return res.json(500, {err: err});
    res.send(204);
  });
}

api.join = function(req, res, next) {
  var user = res.locals.user,
    group = res.locals.group;

  if (group.type == 'party' && group._id == (user.invitations && user.invitations.party && user.invitations.party.id)) {
    user.invitations.party = undefined;
    user.save();
  }
  else if (group.type == 'guild' && user.invitations && user.invitations.guilds) {
    var i = _.findIndex(user.invitations.guilds, {id:group._id});
    if (~i) user.invitations.guilds.splice(i,1);
    user.save();
  }

  group.members.push(user._id);
  async.series([
    function(cb){
      group.save(cb);
    },
    function(cb){
      Group.findById(group._id).populate('members', partyFields).exec(cb);
    }
  ], function(err, results){
    if (err) return res.json(500,{err:err});

    // Remove self from party (see above failing `match` directive in `populate`
    if(results[1].type == 'party') removeSelf(results[1], user);

    res.json(results[1]);
  });
}

api.leave = function(req, res, next) {
  var user = res.locals.user,
    group = res.locals.group;

  Group.update({_id:group._id},{$pull:{members:user._id}}, function(err, saved){
    if (err) return res.json(500,{err:err});
    return res.send(200, {_id: saved._id});
  });
}

api.invite = function(req, res, next) {
  var group = res.locals.group;
  var uuid = req.query.uuid;

  User.findById(uuid, function(err,invite){
    if (err) return res.json(500,{err:err});
    if (!invite)
       return res.json(400,{err:'User with id '+req.query.uid+' not found'});
    if (group.type == 'guild') {
      if (_.contains(group.members,uuid))
        return res.json(400,{err: "User already in that group"});
      if (invite.invitations && invite.invitations.guilds && _.find(invite.invitations.guilds, {id:group._id}))
        return res.json(400, {err:"User already invited to that group"});
      sendInvite();
    } else if (group.type == 'party') {
      if (invite.invitations && !_.isEmpty(invite.invitations.party))
        return res.json(400,{err:"User already pending invitation."});
      Group.find({type:'party', members:{$in:[uuid]}}, function(err, groups){
        if (err) return res.json(500,{err:err});
        if (!_.isEmpty(groups))
          return res.json(400,{err:"User already in a party."})
        sendInvite();
      })
    }

    function sendInvite (){
      if(group.type === 'guild'){
        invite.invitations.guilds.push({id: group._id, name: group.name});
      }else{
        //req.body.type in 'guild', 'party'
        invite.invitations.party = {id: group._id, name: group.name}
      }

      invite.save();
      Group.findById(group._id)
        .populate('members', partyFields).exec(function(err, saved){
          if (group.type === 'party') removeSelf(saved, res.locals.user);
          res.json(saved);
        });

    }
  });
}

api.removeMember = function(req, res, next){
  var group = res.locals.group;
  var uuid = req.query.uuid;
  var user = res.locals.user;
  
  if(group.leader !== user._id){
    return res.json(401, {err: "Only group leader can remove a member!"});
  }

  if(_.contains(group.members, uuid)){
    Group.update({_id:group._id},{$pull:{members:uuid}}, function(err, saved){
      if (err) return res.json(500,{err:err});
      return res.json(saved);
    });
  }else{
    return res.json(400, {err: "User not found among group's members!"});
  }

}