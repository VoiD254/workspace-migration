const admin = require('firebase-admin');
const axios = require('axios');
require('dotenv').config();

const API_BASE_URL = 'http://localhost:3000';
const serviceAccount = JSON.parse(process.env.CREDENTIALS);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com/`
  });
}

const getBearerTokenForUser = async (uid) => {
  try {
    const customToken = await admin.auth().createCustomToken(uid);

    const response = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.API_KEY}`,
      {
        token: customToken,
        returnSecureToken: true,
      }
    );

    return `Bearer ${response.data.idToken}`;
  } catch (error) {
    console.error(`Error generating token for user ${uid}:`, error.response?.data || error.message);
    throw error;
  }
};

const migrateFirebaseUsersToWorkspaces = async () => {
  try {
    console.log('Starting Firebase user migration to workspaces...');
    const allUsers = await getAllFirebaseUsers();
    console.log(`Found ${allUsers.length} Firebase users`);

    for (const user of allUsers.slice(0, 10)) {
      try {
        console.log(`Processing user: ${user.uid} (${user.email})`);
        const workspaceResult = await createWorkspaceForUser(user);
        const workspaceId = workspaceResult._id.toString();

        const userProjects = await getUserOwnedProjects(user.uid);
        console.log(`Found ${userProjects.length} projects for user: ${user.uid}`);

        if (userProjects.length > 0) {
          await updateProjectsWithWorkspaceId(userProjects, user.uid, workspaceId);
        }

        console.log(`✅ Successfully migrated user: ${user.uid}`);
      } catch (userError) {
        console.error(`❌ Error processing user ${user.uid}:`, userError);
        continue;
      }
    }

    console.log('🎉 Migration completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
};

const getAllFirebaseUsers = async () => {
  const allUsers = [];
  let nextPageToken;
  do {
    const listUsersResult = await admin.auth().listUsers(1000, nextPageToken);
    allUsers.push(...listUsersResult.users);
    nextPageToken = listUsersResult.pageToken;
  } while (nextPageToken);
  return allUsers;
};

const createWorkspaceForUser = async (firebaseUser) => {
  try {
    console.log(`Checking for existing workspaces for user: ${firebaseUser.uid}`);
    const existingWorkspaces = await getWorkspacesForUser(firebaseUser.uid);
    
    if (existingWorkspaces && existingWorkspaces.data.response.length !== 0) {
      console.log(`✅ Found existing workspace for user ${firebaseUser.uid}, skipping creation`);
      return existingWorkspaces.data.response[0];
    }
    
    console.log(`No existing workspace found, creating new one for user: ${firebaseUser.uid}`);

    const workspaceRequest = {
      userId: firebaseUser.uid,
      name: firebaseUser.displayName || firebaseUser.email || 'Personal'
    };

    const token = await getBearerTokenForUser(firebaseUser.uid);
    const response = await axios.post(`${API_BASE_URL}/api/v1/workspace/create`, workspaceRequest, {
      headers: { Authorization: token }
    });

    return response.data.data.response;
  } catch (error) {
    console.error(`Error creating workspace for user ${firebaseUser.uid}:`, error.response?.data || error.message);
    throw error;
  }
};

const getUserOwnedProjects = async (firebaseUserId) => {
  try {
    const token = await getBearerTokenForUser(firebaseUserId);
    const response = await axios.post(`${API_BASE_URL}/api/v1/project/getAllUserOwnedProjects`, {
      userId: firebaseUserId,
    }, {
      headers: { Authorization: token }
    });
    
    const projects = response.data.data.response.projects;

    if (!Array.isArray(projects)) {
      console.warn(`⚠️ No valid project list for user ${firebaseUserId}. Response:`, response.data);
      return [];
    }

    return projects;
  } catch (error) {
    console.error(`Error fetching projects for user ${firebaseUserId}:`, error.response?.data || error.message);
    throw error;
  }
};

const updateProjectsWithWorkspaceId = async (projects, oldUserId, workspaceId) => {
  try {
    const token = await getBearerTokenForUser(oldUserId);
    const results = [];
    
    console.log(`🔄 Updating ${projects.length} projects sequentially...`);
    
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      console.log(`Updating project ${i + 1}/${projects.length}: ${project.projectId}`);
      
      try {
        const result = await axios.post(
          `${API_BASE_URL}/api/v1/project/update`,
          { update: { userId: workspaceId } },
          {
            headers: {
              Authorization: token,
              projectId: project.projectId,
            },
            timeout: 30000
          }
        );
          
        results.push(result);
        console.log(`✅ Updated project ${project.projectId}`);
        
        // Small delay between requests
        if (i < projects.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } catch (error) {
        console.error(`❌ Failed to update project ${project.projectId}:`, error.message);
        results.push({ error: error.message, projectId: project.projectId });
      }
    }

    console.log(`✅ Updated ${results.filter(r => !r.error).length}/${projects.length} projects with workspaceId: ${workspaceId}`);
    return results;
  } catch (error) {
    console.error(`❌ Error updating projects for workspaceId ${workspaceId}:`, error.message);
    throw error;
  }
};

const getWorkspacesForUser = async (userId) => {
  try {
    const token = await getBearerTokenForUser(userId);
    const response = await axios.post(`${API_BASE_URL}/api/v1/workspace/getAllForOwner`, {
      userId
    }, {
      headers: { Authorization: token }
    });
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) return [];
    console.error(`Error fetching workspaces for user ${userId}:`, error.response?.data || error.message);
    throw error;
  }
};

const dryRunMigration = async () => {
  console.log('🧪 Running dry run migration...');
  try {
    const allUsers = await getAllFirebaseUsers();
    console.log(`Would process ${allUsers.length} Firebase users`);

    // const userId = "lCwqUbSGYyZIEujXxAMO4Pjohvl2";
    // const userId = "L45i56Z4Mra6OULond8eCh9dEv23";
    for (const user of allUsers.slice(0, 5)) {
      console.log(`Would process user: ${user.uid} (${user.email})`);
      const userProjects = await getUserOwnedProjects(user.uid);
      console.log(`User has ${userProjects.length} owned projects`);
      const existingWorkspaces = await getWorkspacesForUser(user.uid);
      console.log(`User has ${existingWorkspaces?.length || 0} existing workspaces`);
    }

    console.log('✅ Dry run completed');
  } catch (error) {
    console.error('❌ Dry run failed:', error);
  }
};

module.exports = {
  migrateFirebaseUsersToWorkspaces,
  dryRunMigration,
  getAllFirebaseUsers,
  createWorkspaceForUser,
  getUserOwnedProjects,
  updateProjectsWithWorkspaceId
};

if (require.main === module) {
  (async () => {
    try {
      // await dryRunMigration();
      await migrateFirebaseUsersToWorkspaces();
      process.exit(0);
    } catch (error) {
      console.error('Migration script failed:', error);
      process.exit(1);
    }
  })();
}
