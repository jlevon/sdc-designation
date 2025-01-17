/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * This file contains all validation functions used by DAPI. When an allocation
 * request is made, we want to check that all the objects being provided to
 * DAPI in the request are present and in an expected format, to enforce some
 * invariants assumed by later code.
 *
 * Much of this code is called from cnapi, but some is invoked by plugins.
 */

var jsprim = require('jsprim');
var s_dapi = require('joyent-schemas').dapi;

var PLATFORM_RE = /^20\d\d[01]\d[0123]\dT[012]\d[012345]\d\d\dZ$/;
var SAFETY_DELTA = 0.01;  // just some margin when treating floats as integers
var SDC_VERSION_RE = /^\d\.\d$/;
var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
var VALID_SPREADS = ['min-ram', 'max-ram', 'random', 'min-owner'];
var AFFINITY_STR_ATTR = ['key', 'operator', 'value', 'valueType'];
var AFFINITY_VALUE_TYPES = ['exact', 'glob', 're'];

var DEFAULTS_BOOLEAN_ATTR = [
	'filter_headnode',
	'filter_min_resources',
	'filter_large_servers',
	'disable_override_overprovisioning'
];

var DEFAULTS_NUM_ATTR = [
	'filter_vm_limit',
	'overprovision_ratio_cpu',
	'overprovision_ratio_ram',
	'overprovision_ratio_disk',
	'weight_current_platform',
	'weight_next_reboot',
	'weight_num_owner_zones',
	'weight_uniform_random',
	'weight_unreserved_disk',
	'weight_unreserved_ram'
];

/*
 * Validates if a vm is a valid vm object.
 */
function
validateVm(vm)
{
	var tags;

	if (!isHash(vm))
		return ('VM object is an invalid type');

	if (!UUID_RE.test(vm.owner_uuid))
		return ('VM "owner_uuid" is not a valid UUID');

	if (typeof (vm.ram) !== 'number')
		return ('VM "ram" is not a number');

	if (vm.quota && typeof (vm.quota) !== 'number')
		return ('VM "quota" is not a number');

	if (vm.cpu_cap && typeof (vm.cpu_cap) !== 'number')
		return ('VM "cpu_cap" is not a number');

	if (vm.traits) {
		var msg = validateTraits(vm.traits);
		if (msg)
			return ('VM ' + msg);
	}

	if (vm.affinity) {
		msg = validateAffinity(vm.affinity);
		if (msg)
			return ('VM ' + msg);
	}

	if (vm.locality) {
		msg = validateLocality(vm.locality);
		if (msg)
			return ('VM ' + msg);
	}

	tags = vm.nic_tags;
	if (tags) {
		if (!Array.isArray(tags))
			return ('VM "nic_tags" is not an array');

		for (var i = 0; i !== tags.length; i++) {
			if (typeof (tags[i]) !== 'string') {
				return ('VM "nic_tags" contains invalid ' +
					'type in array');
			}
		}
	}

	return (null);
}

/*
 * Checks that all defaults options are valid. Returns an error message if not.
 */
function
validateDefaults(defaults)
{
	var attr;
	var val;
	var i;

	if (!isHash(defaults))
		return ('Defaults object is an invalid type');

	for (i = 0; i !== DEFAULTS_BOOLEAN_ATTR.length; i++) {
		attr = DEFAULTS_BOOLEAN_ATTR[i];
		val  = defaults[attr];

		if (typeof (val) !== 'undefined' && typeof (val) !== 'boolean')
			return ('Defaults ' + attr + ' is not boolean');
	}

	for (i = 0; i !== DEFAULTS_NUM_ATTR.length; i++) {
		attr = DEFAULTS_NUM_ATTR[i];
		val  = defaults[attr];

		if (typeof (val) !== 'undefined' && isNaN(+val))
			return ('Defaults ' + attr + ' is not a number');
	}

	val = defaults.filter_docker_min_platform;
	if (typeof (val) !== 'undefined' && !PLATFORM_RE.test(val)) {
		return ('Defaults filter_docker_min_platform is not an ISO ' +
			'UTC timestamp');
	}

	val = defaults.filter_flexible_disk_min_platform;
	if (typeof (val) !== 'undefined' && !PLATFORM_RE.test(val)) {
		return ('Defaults filter_flexible_disk_min_platform is not ' +
			'an ISO UTC timestamp');
	}

	val = defaults.filter_owner_server;
	if (val) {
		if (!isHash(val)) {
			return ('Defaults filter_owner_server is an invalid' +
				' type');
		}

		var keys = Object.keys(val);
		for (i = 0; i !== keys.length; i++) {
			if (!UUID_RE.test(keys[i]))
				return ('Defaults filter_owner_server keys ' +
					'are not all UUIDs');
		}
	}

	return (null);
}

/*
 * Checks that all trait attributes are valid. Returns an error message if there
 * was a validation error.
 */
function
validateTraits(traits)
{
	return (validate_schema(s_dapi.traits, traits));
}


/*
 * Checks that [min|max]_platform are in an acceptable format. Returns an error
 * message if not.
 */
function
validatePlatformLimits(requirements, requirementName, prefix)
{
	var platforms = requirements[requirementName];
	var path;
	var versions;

	if (platforms === undefined)
		return (null);

	path = prefix + requirementName;

	if (!isHash(platforms))
		return ('"' + path + '" is not a hash');

	versions = Object.keys(platforms);

	for (var i = 0; i !== versions.length; i++) {
		var version = versions[i];
		var timestamp = platforms[version];

		if (typeof (version) !== 'string' ||
		    !version.match(SDC_VERSION_RE)) {
			return ('"' + path +
			    '" contains an invalid SDC version');
		}

		if (typeof (timestamp) !== 'string' ||
		    !timestamp.match(PLATFORM_RE)) {
			return ('"' + path +
			    '" contains an invalid platform date');
		}
	}

	return (null);
}

/*
 * Checks that if an affinity exists, it has the expected format. Affinity
 * consists of an array of objects, each object having 'key', 'value,'
 * 'valueType', 'operator', 'isSoft' attributes.
 */
function validateAffinity(affinities)
{
	if (!affinities)
		return (null);

	if (!Array.isArray(affinities))
		return ('"affinity" is not an array');

	for (var i = 0; i < affinities.length; i++) {
		var affinity = affinities[i];

		for (var j = 0; j < AFFINITY_STR_ATTR.length; j++) {
			var attr = AFFINITY_STR_ATTR[j];

			if (typeof (affinity[attr]) !== 'string')
				return ('"affinity.' + attr +
					'" is not a string');
		}

		if (typeof (affinity.isSoft) !== 'boolean')
			return ('"affinity.isSoft" is not a boolean');

		if (affinity.operator !== '==' && affinity.operator !== '!=')
			return ('"affinity.operator" has invalid operator');

		if (AFFINITY_VALUE_TYPES.indexOf(affinity.valueType) === -1)
			return ('"affinity.valueType" has invalid value');
	}

	return (null);
}

/*
 * Checks that if a locality hint exists, it has the expected format -- it is
 * a hash, 'near' and 'far' are valid keys, and values must be either UUIDs or
 * arrays of UUIDs. Returns an error message if there was a validation error.
 */
function validateLocality(locality)
{
	var check;
	var msg;

	if (!locality)
		return (null);

	if (!isHash(locality))
		return ('"locality" is has wrong type');

	check = function (hintName) {
		var hint = locality[hintName];
		var errKey = '"locality.' + hintName + '"';

		if (!hint)
			return (null);

		if (typeof (hint) !== 'string' && !Array.isArray(hint))
			return (errKey + ' is neither string nor array');

		if (typeof (hint) === 'string' && !UUID_RE.test(hint))
			return (errKey + ' is not a UUID');

		if (Array.isArray(hint)) {
			for (var i = 0; i !== hint.length; i++) {
				if (!UUID_RE.test(hint[i])) {
					return (errKey +
					    ' contains an malformed UUID');
				}
			}
		}

		return (null);
	};

	msg = check('near');
	if (msg)
		return (msg);

	msg = check('far');
	if (msg)
		return (msg);

	var strict = locality.strict;
	if (typeof (strict) !== 'undefined' && typeof (strict) !== 'boolean')
		return ('"locality.strict" is given, but not boolean');

	return (null);
}

function validateNicTagRequirements(nic_tag_requirements) {
	return (validate_schema(s_dapi.nic_tag_reqs, nic_tag_requirements));
}

/*
 * Validates a VM payload -- this includes the VM and checking of
 * and requirements attribute. Returns an error message if validation fails.
 */
function validateVmPayload(vm, requirements) {
	var msg = validateVm(vm);

	if (msg)
		return (msg);

	if (!UUID_RE.test(vm.vm_uuid))
		return ('"vm.vm_uuid" is an invalid UUID');

	var metadata = vm.internal_metadata;
	if (metadata) {
		if (typeof (metadata) !== 'object') {
			return ('"vm.internal_metadata" is not a hash');
		}

		var volFrom = metadata['docker:volumesfrom'];
		if (volFrom) {
			try {
				volFrom = JSON.parse(volFrom);
			} catch (e) {
				return ('"vm.internal_metadata[\'docker:' +
					'volumesfrom\']" is not valid JSON');
			}

			if (!Array.isArray(volFrom)) {
				return ('"vm.internal_metadata[\'docker:' +
					'volumesfrom\']" does not contain ' +
					'an array');
			}

			// A bit dodgy mutating this in validation code, but it
			// ensures we're not trying to deserialise it twice,
			// with the potential attendant bugs.
			metadata['docker:volumesfrom'] = volFrom;
		}
	}

	if (requirements) {
		var minRam = requirements.min_ram;
		var maxRam = requirements.max_ram;

		if (minRam && vm.ram < minRam - SAFETY_DELTA) {
			return ('"vm.ram" is smaller than ' +
			    '"image.requirements.min_ram"');
		}

		if (maxRam && vm.ram > maxRam + SAFETY_DELTA) {
			return ('"vm.ram" is larger than ' +
			    '"image.requirements.max_ram"');
		}
	}

	return (null);
}

/*
 * This one is a bit of an odd duck. It does not validate all servers, rather
 * only checks that servers is an array. The validation of each server occurs
 * in plugin for two reasons:
 *
 * 1) so that ops can see from steps output that a server was removed, not
 *	invisibly disappearing with only a log entry they never check
 *
 * 2) We do not want to halt an allocation just because one server is invalid
 */
function validateServers(servers) {
	if (!Array.isArray(servers))
		return ('"servers" input is not an array');

	if (servers.length === 0)
		return ('"servers" array is empty');

	return (null);
}

/*
 * Validates a server. Returns an error message if validation fails.
 */
function validateServer(server) {
	return (validate_schema(s_dapi.server, server));
}

/*
 * Validates an image. Returns an error message if validation fails.
 */
function
validateImage(image)
{
	if (!isHash(image))
		return ('"image" has invalid type');

	var imgSize = image.image_size;
	if (imgSize && typeof (imgSize) !== 'number')
		return ('"image.image_size" has invalid type');

	if (image.traits) {
		var msg = validateTraits(image.traits);
		if (msg)
			return (msg);
	}

	if (image.requirements) {
		var requirements = image.requirements;
		var prefix = 'requirements.';

		if (!isHash(requirements))
			return ('"image.requirements" has invalid type');

		msg = validatePlatformLimits(requirements,
		    'min_platform', prefix);
		if (msg)
			return (msg);

		msg = validatePlatformLimits(requirements,
		    'max_platform', prefix);
		if (msg)
			return (msg);

		var minRam = requirements.minRam;
		if (minRam && typeof (minRam) !== 'number') {
			return (
			    '"image.requirements.min_ram" has invalid type');
		}

		var maxRam = requirements.maxRam;
		if (maxRam && typeof (maxRam) !== 'number')
			return (
			    '"image.requirements.max_ram" has invalid type');
	}

	return (null);
}

/*
 * Validates all images. Returns an error message if any of the images is
 * invalid.
 */
function
validateImages(images)
{
	if (!Array.isArray(images))
		return ('"images" is not an array');

	for (var i = 0; i !== images.length; i++) {
		var image = images[i];
		var msg = validateImage(image);

		if (msg)
			return ('image uuid "' + image.uuid + '" - ' + msg);
	}

	return (null);
}

/*
 * Validates a package. Returns an error message if validation fails.
 */
function validatePackage(pkg) {
	if (!isHash(pkg))
		return ('"package" has invalid type');

	var overprovisionCpu = pkg.overprovision_cpu;
	if (overprovisionCpu && Number.isNaN(+overprovisionCpu))
		return ('"package.overprovision_cpu" has invalid type');

	var overprovisionRam = pkg.overprovision_memory;
	if (overprovisionRam && Number.isNaN(+overprovisionRam))
		return ('"package.overprovision_memory" has invalid type');

	var overprovisionDisk = pkg.overprovision_storage;
	if (overprovisionDisk && Number.isNaN(+overprovisionDisk))
		return ('"package.overprovision_storage" has invalid type');

	var overprovisionNet = pkg.overprovision_network;
	if (overprovisionNet && Number.isNaN(+overprovisionNet))
		return ('"package.overprovision_network" has invalid type');

	var overprovisionIo = pkg.overprovision_io;
	if (overprovisionIo && Number.isNaN(+overprovisionIo))
		return ('"package.overprovision_io" has invalid type');

	var spread = pkg.alloc_server_spread;
	if (spread && VALID_SPREADS.indexOf(spread) === -1)
		return ('"alloc_server_spread" has invalid value');

	var parse = function (name, validator) {
		var val = pkg[name];
		var msg;

		if (!val)
			return (null);

		/* XXX */
		if (typeof (val) === 'string') {
			try {
				pkg[name] = JSON.parse(val);
			} catch (e) {
				return ('"package.' + name +
				    '" has invalid type');
			}
		}

		msg = validator(pkg, name, 'package.');
		if (msg)
			return (msg);

		return (null);
	};

	var minPlatformErr = parse('min_platform', validatePlatformLimits);
	if (minPlatformErr)
		return (minPlatformErr);

	var maxPlatformErr = parse('max_platform', validatePlatformLimits);
	if (maxPlatformErr)
		return (maxPlatformErr);

	var traitShim = function () { return validateTraits(pkg.traits); };
	var traitErr = parse('traits', traitShim);
	if (traitErr)
		return ('"package.traits": ' + traitErr);

	return (null);
}

/*
 * Validates all packages. Returns an error message if any of the packages is
 * invalid.
 */
function
validatePackages(pkgs)
{
	if (!Array.isArray(pkgs))
		return ('"packages" is not an array');

	for (var i = 0; i !== pkgs.length; i++) {
		var pkg = pkgs[i];
		var msg = validatePackage(pkg);

		if (msg)
			return ('package uuid "' + pkg.uuid + '" - ' + msg);
	}

	return (null);
}

/*
 * Validates a ticket. Returns an error message if validation fails.
 */
function validateTicket(ticket) {
	if (!isHash(ticket))
		return ('"ticket" has invalid type');

	if (!UUID_RE.test(ticket.id))
		return ('"id" is not a valid UUID');

	if (!UUID_RE.test(ticket.server_uuid))
		return ('"server_uuid" is not a valid UUID');

	if (typeof (ticket.scope) !== 'string')
		return ('"scope" is not a string');

	if (typeof (ticket.action) !== 'string')
		return ('"action" is not a string');

	if (typeof (ticket.status) !== 'string')
		return ('"status" is not a string');

	return (null);
}

/*
 * Validates all tickets. Returns an error message if any of the tickets is
 * invalid.
 */
function
validateTickets(tickets)
{
	if (!Array.isArray(tickets))
		return ('"tickets" is not an array');

	for (var i = 0; i !== tickets.length; i++) {
		var ticket = tickets[i];
		var msg = validateTicket(ticket);

		if (msg)
			return ('ticket uuid "' + ticket.id + '" - ' + msg);
	}

	return (null);
}

/*
 * Javascript is too loose with the definition of 'object'. This is here to
 * check that a hash is indeed a hash, not a null or array. :/
 */
function
isHash(obj)
{
	return (obj && typeof (obj) === 'object' && !Array.isArray(obj));
}

/*
 *
 */
function
validate_schema(schema, obj)
{
	var e = jsprim.validateJsonObject(schema, obj);

	if (e !== null)
		return (e.message);

	return (null);
}


module.exports = {
	validateVm: validateVm,
	validateVmPayload: validateVmPayload,
	validateDefaults: validateDefaults,
	validateTraits: validateTraits,
	validateAffinity: validateAffinity,
	validateLocality: validateLocality,
	validateServer: validateServer,
	validateServers: validateServers,
	validateImage: validateImage,
	validateImages: validateImages,
	validateNicTagRequirements: validateNicTagRequirements,
	validatePackage: validatePackage,
	validatePackages: validatePackages,
	validateTicket: validateTicket,
	validateTickets: validateTickets,
	validatePlatformLimits: validatePlatformLimits
};
