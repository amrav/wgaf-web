var _ = require('underscore');
var m = require('./mongoose');
var utils = require('./utils.js');
var log = utils.log;
var jwt = require('jsonwebtoken');
var mail = require('./mail');
require('sugar');
var restify = require('restify');
var SECRET = utils.SECRET;

function new_(req, res, next) {
    if (!utils.validateRequest(req, res, next, ['username', 'email', 'password'])) {
        return;
    }

    if (!utils.validateUsername(req.params.username)) {
        next(restify.errors.InvalidArgumentError('username invalid'));
        return;
    }

    var user = new m.User({'username': req.params.username,
                           'email': req.params.email,
                           'password': req.params.password,
                           'verified': false,
                           'updated': Date.create("1 day ago")});
    user.save(function(err, user) {
	if (err && err.code === m.UNIQUE_KEY_ERROR) {
            return next(new restify.errors.InvalidArgumentError('username already exists'));
	}
	else if (err) {
            throw(err);
	}
	else {
            req.log.info({user: user}, "New user created");
            res.send(200);
            mail.verify(user.username, user.email, function(err) {
                if (err) {
                    log.error(err);
                } else {
                    req.log.info("Sent verification email to " + user.email);
                }
            });
            return next();
	}
    });
}

function search(req, res, next) {
    if (req.query.search) {
        m.User
            .find({$or: [
                {username: {$regex: RegExp.escape(req.query.search),
                            $options: 'i'}},
                {email: req.query.search}
            ]}, {username: 1, _id:0})
            .sort({username: 1})
            .limit(10)
            .exec(function(err, users) {
                if (err) {
                    throw err;
                }
                users = users || [];
                res.send(200, users);
                return next();
            });
    } else {
        return next(new restify.errors.MissingParameterError('search term required'));
    }
}

function del(req, res, next) {
    if (!utils.validateRequest(req, res, next, ['token', 'username']))
        return;

    m.User.findOneAndRemove(
        {'username': req.user.username},
        function (err, user) {
            if (err) {
                res.send(500);
                req.log.error(err);
            }
            else if (user === null) {
                res.send(404, {"code": "NoUserFound", "message": "no such user exists"});
            }
            else {
                res.send(200, {"status": "User deleted"});
                req.log.info({user: user}, "Deleted user");
            }
            next();
        });
}

function follow(req, res, next) {
    if (!utils.validateRequest(req, res, next, ['target']))
        return;

    if (req.user.username === req.params.target) {
        next(new restify.errors.InvalidArgumentError('cannot follow yourself'));
        return;
    }

    m.User.find({username: {$in: [req.user.username, req.params.target]}},
                function(err, users) {
                    if (err) {
                        throw err;
                    }
                    if (users.length !== 2) {
                        return next(new restify.errors.ResourceNotFoundError('no such user found'));
                    }
                    var follower, followed;
                    if (users[0].username === req.user.username) {
                        follower = users[0];
                        followed = users[1];
                    } else {
                        follower = users[1];
                        followed = users[0];
                    }
                    if (follower.following.indexOf(followed.username) > -1) {
                        return next(new restify.errors.InvalidArgumentError('already following ' + followed.username));
                    }
                    follower.following.push(followed.username);
                    followed.followers.push(follower.username);
                    follower.save(function(err, yell) {
                        if (err) {
                            throw err;
                        }
                        followed.save(function(err, yell) {
                            if (err) {
                                throw err;
                            }
                            req.log.info({follower: follower.username, followed: followed.username},
                                         "Saved follow");
                            res.send(200);
                            return next();
                        });
                    });
                });
}

function verify(req, res, next) {
    if (!utils.validateRequest(req, res, next, ['verify'])) {
        return;
    }

    jwt.verify(req.params.verify, utils.SECRET, function(err, token) {
        if (err) {
            next(new restify.errors.InvalidArgumentError('Verification code invalid'));
            return;
        }
        if (token.sub !== 'verify') {
            next(new restify.errors.InvalidArgumentError('Verification code invalid'));
            return;
        }
        m.User.findOne(
            {username: token.username}, {verified: true},
            function(err, user) {
                if (err) {
                    throw err;
                }
                user.verified = true;
                user.save(function(err, user) {
                    if (err) {
                        throw err;
                    }
                    req.log.info({user: token.username}, "Verified email");
                    res.header('Location', utils.APP_URL);
                    res.send(302);
                    mail.welcome(user.username, user.email);
                    next();
                });
            });
    });
}

function get(req, res, next) {
    m.User
        .findOne({username: req.params.username})
        .select({username: 1, followers: 1, following: 1, _id: 0})
        .exec(function(err, user) {
            if (err) {
                throw err;
            } else if (!user) {
                next(new restify.errors.ResourceNotFoundError('no such username'));
                return;
            } else {
                res.send(200, user);
                next();
            }
        });
}

function forgotPassword(req, res, next) {
    if (!utils.validateRequest(req, res, next, ['email'])) {
        return;
    }
    m.User
        .findOne({
            email: req.params.email
        })
        .select('username email')
        .exec(function(err, user) {
            if (err) {
                throw err;
            } else if (!user) {
                next(new restify.errors.ResourceNotFoundError('no such username'));
            } else {
                mail.forgotPassword(user.username, user.email, function(err) {
                    if (err) {
                        throw err;
                    } else {
                        res.send(200);
                    }
                });
            }
        });
}

function resetPassword(req, res, next) {
    if (!utils.validateRequest(req, res, next, ['password', 'token'])) {
        return;
    }
    jwt.verify(req.params.token, utils.SECRET, function(err, token) {
        if (err || req.params.username !== token.username) {
            next(new restify.errors.InvalidArgumentError('password reset token invalid'));
            return;
        }
        m.User
            .findOne({
                username: token.username
            })
            .exec(function(err, user) {
                if (err) {
                    throw err;
                } if (!user) {
                    next(new restify.errors.InvalidArgumentError('password reset token invalid'));
                } else {
                    user.password = req.params.password;
                    user.verified = true;
                    user.save(function(err, user) {
                        if (err) {
                            throw err;
                        }
                        log.info({username: user.username}, 'Password reset');
                        res.send(200);
                    });
                }
            });
    });
}

exports.new_ = new_;
exports.del = del;
exports.follow = follow;
exports.verify = verify;
exports.search = search;
exports.get = get;
exports.forgotPassword = forgotPassword;
exports.resetPassword = resetPassword;
